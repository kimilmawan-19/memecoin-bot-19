# Phase 6: gerbang risiko deterministik

Phase 6 menambahkan pemeriksaan risiko **hanya untuk simulasi**. Tidak ada wallet nyata, signer, transaksi, SDK FnZero, API pasar, order otomatis, atau kebijakan live. Siklus CLI bawaan tetap memakai fixture Phase 1 dan selalu memutuskan `SKIP`.

## Alur dan pemilik keputusan

```text
Proposal BUY (tidak dipercaya)
  -> parse skema proposal
  -> gerbang fakta token + konflik intelijen
  -> batas portofolio
  -> guard quote, saldo, biaya, slippage, program manifest, idempotensi
  -> SIMULATION_ALLOWED atau BLOCKED
  -> adapter FnZero dry-run, hanya jika lolos
  -> SIMULATED atau null; tanpa signature
```

`src/risk/policy.ts` memvalidasi konfigurasi lokal yang eksplisit, berversi dan immutable. Tidak ada nilai batas risiko default. Semua jumlah adalah string base unit: likuiditas, posisi, eksposur dan rugi harian dalam base unit `quoteMint`; fee dalam lamport sesuai kontrak fixture Phase 3. Batas numerik di tes hanyalah contoh sintetis, **bukan** rekomendasi untuk trading live.

`src/risk/token.ts` mengevaluasi otoritas mint/freeze, dukungan program token, struktur vault dan supply, serta cadangan quote minimum. `null`, data basi, mint/quote tidak cocok, atau konflik intelijen menghasilkan `UNKNOWN`; kondisi yang jelas melanggar aturan menghasilkan `REJECT`. Kedua status memblokir simulasi. Nilai `true` dalam `TokenRiskFacts` Phase 6 adalah **klaim fixture**, belum bukti on-chain. `PASS` di sini hanya berarti klaim fixture lolos aturan sintetis.

`src/risk/portfolio.ts` memeriksa kill switch, rugi harian, ukuran posisi, total eksposur termasuk order tertunda, jumlah posisi dan order aktif, serta order yang belum terselesaikan. Data portofolio harus segar; fakta kritis yang tidak tersedia tidak dianggap nol. Rugi harian dan eksposur dibaca dari snapshot sintetis, belum dihitung dari posisi yang direkonsiliasi.

`src/risk/guard.ts` mengikat proposal, snapshot intelijen, intent BUY, versi policy, quote, saldo, wallet ID dan daftar program fixture. Batas harga mencakup umur quote, batas slippage terhadap output yang diharapkan, price impact, fee, min output dan saldo. ID intent yang sudah lolos ditolak ketika dipakai ulang dalam instance guard yang sama. Guard tidak mengembalikan `AuthorizedExecutionRequest`; hasilnya hanya `SIMULATION_ALLOWED` atau `BLOCKED`. `src/application/simulate.ts` menggunakan hasil itu untuk memanggil adapter dry-run; tidak ada jalur eksekusi live.

## Batas keamanan yang masih terbuka

- Semua fakta pasar, token dan portofolio Phase 6 berasal dari fixture. Belum ada adapter on-chain untuk membuktikan mint authority, freeze authority, program owner, pool/vault, supply, reserve, harga, atau PnL pada slot/commitment yang konsisten. Sebelum fakta itu dipakai untuk keputusan nyata, ambil dan verifikasi secara independen terhadap akun Solana dan catat provenance per fakta.
- `instructionProgramIds` hanya manifest yang diberikan fixture. Pemeriksaan allowlist ini dapat menemukan ID program yang tidak diizinkan dalam tes, tetapi **tidak** memvalidasi pesan transaksi atau seluruh instruksi yang akan ditandatangani. Implementasi live harus mendekode pesan final setelah SDK membangun transaksi dan sebelum signer, lalu memeriksa program, akun writable/signer, penerima, mint, jumlah, otoritas dan batas biaya terhadap intent yang disetujui. Bila tidak cocok, jangan tanda tangani.
- Set idempotensi dan reservation berada dalam satu instance guard. Pemeriksaan dan reservation sinkron berlaku atomik dalam instance itu. Restart atau beberapa worker tetap memerlukan penyimpanan transaksional bersama dan rekonsiliasi signature/status `UNKNOWN` sebelum mengulang order. Tidak ada otorisasi live sampai hal ini tersedia.
- `simulateGuardedBuy` hanya mencakup BUY. Exit darurat dan manajemen posisi adalah pekerjaan Phase 8; kebutuhan exit tidak boleh mengandalkan LLM. Jalur SELL dry-run Phase 3 masih dapat diuji secara terpisah dan tidak menjadi jalur SELL terotorisasi.
- Tidak ada GMGN atau provider live yang diaktifkan. Data GMGN bersifat pelengkap dan tidak boleh menggantikan fakta kritis on-chain.

## Verifikasi

Jalankan `node --test tests/risk-engine.test.ts`, `node --test tests/*.test.ts`, dan `pnpm typecheck`. Tes Phase 6 membuktikan batas kebijakan, `UNKNOWN` yang memblokir, kill switch, rugi dan eksposur, data basi, quote yang tidak cocok, slippage/fee/impact, program yang tidak ada di allowlist, intent berulang, serta alur dry-run tanpa signature. Ini adalah bukti perilaku kode pada fixture, bukan bukti keamanan trading live.

## Pembaruan setelah audit

`simulateGuardedBuy` menerima fungsi `clock`, menyalin/membekukan input sebelum menunggu provider, lalu membaca waktu baru saat guard berjalan. Quote/saldo diperiksa satu kali dan snapshot yang sama dipakai preview sinkron. Hasil preview harus cocok dengan request/quote yang diperiksa.

`TokenRiskFacts` wajib membawa `poolId` dan `quoteDecimals`, sesuai konteks intelijen serta quote. `PortfolioSnapshot.exposureByMint` wajib memuat exposure committed dan pending per mint; jumlahnya harus sama dengan total ditambah pending exposure. Setiap allowance mencadangkan exposure, saldo quote, jumlah order, dan slot posisi baru. Preview gagal/null melepaskan reservation; intent ID tetap dikonsumsi. Preview berhasil mempertahankan reservation sepanjang sesi guard, karena belum ada posisi/reconciliation yang mengambil alih kepemilikannya.

Gunakan satu instance guard bersama dalam satu sesi. Jangan membuat guard baru per order. Jangan memasukkan ulang reservation lokal ke snapshot eksternal: itu akan dihitung dua kali dan memblokir secara konservatif. Tidak ada pelepasan otomatis berdasarkan umur; sesi ini bukan ledger paper trading atau live. Saldo native SOL untuk fee/rent tetap belum dimodelkan.
