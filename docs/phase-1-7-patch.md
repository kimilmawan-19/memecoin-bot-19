# Patch audit Phase 1–7

Patch ini menindaklanjuti F1–F6 pada [laporan audit](phase-1-7-audit.md). Semua perubahan tetap khusus fixture/simulasi. Tidak ada dependency produksi, wallet, signer, transaksi, atau pemanggilan API nyata yang ditambahkan.

## Perubahan dan bukti regresi

| Temuan | Perbaikan | Bukti |
|---|---|---|
| F1: quote berubah setelah guard | Quote/saldo disalin dan dibekukan sekali. Preview sinkron memakai fakta yang diperiksa; tidak mengambil quote lagi. Hasil preview yang berbeda ditolak. | `tests/risk-engine.test.ts`: fixture berubah menjadi impact 9999 bps setelah fetch pertama, tetapi preview tetap memakai snapshot impact 100 bps; quote dipanggil sekali. Quote awal di luar policy ditolak. |
| F2: konteks mata uang hilang | Kontrak `MarketContext` mempertahankan pool, quote mint, decimals, dan window. Konteks campuran tidak digabung. Token facts dan quote harus cocok. Prompt menerima satuan, window, dan confidence. | `tests/providers.test.ts`, `tests/risk-engine.test.ts`, `tests/screener.test.ts`: perbedaan quote/pool/decimals/window, konteks hilang, dan projection prompt. |
| F3: waktu lama | Fungsi clock dibaca setelah provider/LLM selesai. Risiko token dinilai ulang sebelum menerima proposal. | `tests/risk-engine.test.ts`, `tests/evaluate.test.ts`, `tests/screener.test.ts`: quote 20 detik ditolak oleh batas 15 detik, proposal kedaluwarsa menjadi SKIP, token facts kedaluwarsa menjadi UNKNOWN. |
| F4: allowance tanpa reservation | Guard bersama mencadangkan exposure per mint/total, saldo quote, active orders dan posisi baru secara sinkron. Gagal/null melepaskan kapasitas, tanpa membuka ulang ID. | `tests/risk-engine.test.ts`: intent berbeda sekuensial/paralel, batas posisi/total/order/saldo, kegagalan preview dan pelepasan reservation. |
| F5: mutasi snapshot | Evaluator dan agent memegang salinan immutable sebelum await. Lesson dan schema juga dibekukan. | `tests/evaluate.test.ts`, `tests/screener.test.ts`: mutasi input tidak mengganti snapshot proposal; evidence yang ditambahkan selama await ditolak. |
| F6: stream tidak ditutup | Body dibatalkan saat status/header ditolak; reader dibatalkan saat pembacaan gagal atau terlalu besar. | `tests/http-cleanup.test.ts`: RPC/LLM, 429/500, content type salah, dan overflow; cancel dipanggil dan lock dilepas. |

## Tes integrasi offline

`tests/pipeline.test.ts` menyambungkan parser/index discovery dari rekaman instruksi, feature fixture, normalizer, risk gate, mock LLM, jurnal, guard, dan adapter dry-run. Skenario mencakup BUY sintetis, SKIP, konflik pasar, timeout LLM, kill switch, dan pool quote salah. Hanya skenario BUY yang lolos policy menghasilkan SIMULATED, dengan signature kosong.

Rekaman discovery dan data intelijen sintetis bukan dataset historis yang konsisten untuk mengukur profit. Tes ini membuktikan kontrak antarmodul.

## Kontrak yang berubah

- Observasi wajib membawa `market`. Feature fixture wajib mempunyai `quoteDecimals`. Fixture lama tanpa konteks ditolak; tidak ada default yang menebak mata uang.
- `TokenIntelligence.market` adalah null ketika bukti tidak tersedia atau konteks berkonflik.
- `TokenRiskFacts` menambahkan `poolId` dan `quoteDecimals`; `QuoteRequest` menambahkan `poolId`.
- `PortfolioSnapshot.exposureByMint` mencakup committed dan pending exposure. Jumlahnya harus cocok dengan agregat.
- `evaluateCandidate` dan `simulateGuardedBuy` menerima `clock: () => Date`.
- `DryRunTradingAdapter.buy/sell(request, facts)` menjadi preview sinkron. Pengambilan quote/saldo tetap asynchronous melalui port baca.
- Prompt version menjadi `screener-v2`. Hash snapshot ikut berubah karena konteks kini disertakan.
- Validator alamat dipindahkan ke `src/core/address.ts`; `input.ts` tetap re-export untuk kompatibilitas pemanggil lama.

## Batas yang tetap berlaku

- Gunakan satu instance guard bersama untuk satu sesi simulasi. Reservation berhasil ditahan sampai sesi selesai. Kegagalan/null saja yang dilepas. Restart/multi-worker dan pemindahan reservation ke posisi persisten memerlukan lifecycle/reconciliation tersendiri.
- Snapshot eksternal harus mengecualikan reservation lokal instance guard. Jika dimasukkan lagi, exposure akan dihitung dua kali dan diblokir secara konservatif.
- Saldo native SOL untuk fee/rent, verifikasi on-chain, transaksi final, hard exclusion fitur yang terkalibrasi, persistence dan strategi trading tetap belum dibangun.
- CLI default tetap contoh SKIP lama. Integrasi menyeluruh sekarang dibuktikan lewat tes offline; belum ada scheduler atau aplikasi paper trading penuh.
- Tidak dilakukan rewrite arsitektur atau penghapusan jalur CLI lama pada patch keamanan ini.

## Verifikasi

Jalankan `pnpm test`, `pnpm typecheck`, dan `git diff --check`. Tes memakai transport palsu, clock yang diinjeksi, dan fixture; tidak memerlukan kredensial.

Hasil verifikasi lokal: **74 tes lulus, 0 gagal** (12 tes tambahan), typecheck lulus, dan diff check lulus. Keenam skenario integrasi offline tercakup di satu tes pipeline.

## Review PR #6 — 1 Oktober 2026

Review lanjutan menemukan dua celah kapasitas ketika snapshot portofolio sudah membawa order BUY pending, terpisah dari reservation lokal guard:

- **Slot posisi (P2):** `openPositionCount` belum mencakup mint yang baru ada di order pending. Satu mint pending dan satu BUY mint baru bisa lolos batas satu posisi. Portfolio gate sekarang membatasi gabungan mint committed, pending, dan mint yang akan dibeli.
- **Saldo quote (P2):** saldo hanya dikurangi reservation lokal; quote untuk pending BUY dari snapshot bisa dipakai kembali. Guard sekarang mensyaratkan saldo cukup untuk pending eksternal + reservation lokal + BUY baru. Exposure committed tidak dikurangi lagi karena sudah memakai saldo saat pembelian sebelumnya.

Kontrak simulasi diperjelas: `BalanceSnapshot.amountRaw` adalah saldo quote total yang teramati, belum dikurangi reservation. `pendingExposureQuoteRaw` adalah input quote yang masih dicadangkan bagi BUY belum terisi di luar guard; snapshot harus mengecualikan reservation lokal. Model ini belum menangani partial fill, escrow, fee/rent atau rekonsiliasi akun live.

Kedua tes regresi gagal pada baseline PR `a6de1f1` dengan `SIMULATION_ALLOWED`, lalu lulus setelah patch. Tes juga memeriksa batas saldo tepat, kombinasi pending eksternal/lokal, dan tidak mencadangkan ulang exposure committed.

Verifikasi setelah review: **76 tes lulus, 0 gagal**; `pnpm typecheck` dan `git diff --check` lulus. Validasi lokal/offline; tidak ada bukti uji provider live atau GitHub Actions.
