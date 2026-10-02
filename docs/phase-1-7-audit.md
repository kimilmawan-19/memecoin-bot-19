# Audit integrasi dan keamanan Phase 1–7

Tanggal: 30 September 2026. Baseline: `bf071b1b5e3f3d753aa90ce22996b58d648fa53a`, branch `codex/phase-7-screener`.

> Status tindak lanjut: F1–F6 telah dipatch setelah audit ini. Lihat [catatan patch](phase-1-7-patch.md). Temuan dan bukti di bawah menggambarkan baseline yang diaudit, bukan status source setelah patch.

## Kesimpulan

Arah modul sesuai arsitektur: kontrak domain, provider observasi, fitur, risiko deterministik, Screener pemberi proposal, dan adapter dry-run terpisah. Namun, belum ada aplikasi yang menjalankan seluruh modul tersebut dalam satu siklus. CLI masih menjalankan contoh lama yang selalu `SKIP`. Integrasi menyeluruh memang direncanakan kemudian; kelulusan tes sekarang tidak membuktikan bot lengkap sudah berjalan.

Audit menemukan enam masalah yang dapat direproduksi: perubahan quote setelah guard, hilangnya konteks mata uang, waktu pemeriksaan yang tertinggal, allowance berulang tanpa reservation, perubahan snapshot selama permintaan LLM, dan body HTTP yang tidak dibatalkan pada beberapa jalur gagal. Perbaiki batas data dan guard sebelum memperluas manajemen posisi.

Tidak ditemukan jalur pembacaan atau pengiriman private key dalam source aplikasi yang diperiksa. Tidak ada signer, SDK trading terpasang, atau pengiriman transaksi. Temuan guard saat ini memengaruhi hasil simulasi; ini bukan bukti adanya transaksi live atau dana yang hilang.

Audit hanya menambahkan dokumen ini. Source, tes permanen, dependensi, dan konfigurasi tidak diubah.

## Metode dan hasil verifikasi

- Menelusuri seluruh source Phase 1–7, manifest, lockfile, tes, dan catatan fase.
- `pnpm test`: **62 lulus, 0 gagal**.
- `pnpm typecheck`: lulus, exit code 0.
- `git diff --check`: lulus sebelum penambahan laporan; diulang setelah laporan dibuat.
- Probe tambahan dijalankan melalui stdin Node dengan `--input-type=module-typescript`. Tidak meninggalkan file kode atau tes.
- Probe memakai fixture, provider palsu, dan clock yang diinjeksi. Tidak memanggil RPC, GMGN, LLM nyata, atau wallet.
- Tidak melakukan audit ulang donor, pemindaian seluruh sejarah Git, audit binari Node, atau pemeriksaan CVE daring. Kesimpulan keamanan dibatasi pada kode dan dependency manifest yang tersedia.

## Status tiap fase

| Fase | Sambungan yang tersedia | Penilaian |
|---|---|---|
| 1 — Core | Domain, proposal parser, port, mode fixture, aturan transisi | Fondasi tersedia. Ada dua keluarga domain/risk karena jalur CLI lama masih hidup. |
| 2 — Provider/mock | Provider fixture dan normalisasi menghasilkan `TokenIntelligence` | Dipakai oleh fitur dan Screener. Kontrak observasi kehilangan konteks denominasi/pool/window. GMGN hanya simulator kuota. |
| 3 — Adapter dry-run | Quote, balance, BUY/SELL preview tanpa signature | Tersambung ke guard dalam tes. Quote diambil ulang setelah pemeriksaan guard. |
| 4 — Discovery | Parser Pump/PumpSwap/Raydium CPMM, poller, RPC baca-saja | Parser dan recovery diuji terpisah. Belum ada penghubung discovery ke pengumpulan fitur dalam aplikasi. |
| 5 — Intelligence | Frame sintetis menghasilkan observasi Phase 2 | Kalkulasi dan provenance tersedia. Konteks frame tidak ikut diteruskan ke domain/prompt. |
| 6 — Risk | Token facts, portfolio caps, guard, `simulateGuardedBuy` | Teruji untuk satu input. Ada masalah waktu, quote, dan reservation antar-intent. Fakta keamanan tetap fixture. |
| 7 — Screener | Gate Phase 6 mendahului LLM dalam `evaluateCandidate` | Schema, timeout, bukti, dan pemisahan eksekusi tersedia. Binding snapshot masih bergantung pada input tidak berubah. |

## Temuan yang perlu diperbaiki

Prioritas di bawah adalah urutan patch untuk proyek simulasi ini, bukan penilaian insiden live. **P1**: perbaiki sebelum menyatukan alur aplikasi. **P2**: perbaiki sebelum menjalankan siklus berulang/manajemen posisi. **P3**: perbaikan ketahanan dengan dampak lebih rendah.

### F1 — P1: quote yang diperiksa guard berbeda dari quote yang dipakai preview

Lokasi: `src/application/simulate.ts:22–32`; `src/execution/fnzero/dry-run.ts:189–193`.

`simulateGuardedBuy` mengambil quote, memeriksanya melalui guard, lalu memanggil `adapter.buy(request)`. Adapter mengambil quote lagi. Hasil kedua tidak melewati batas price impact milik guard; request tidak mengikat hasil quote yang telah diperiksa.

**Bukti:** memakai `FnzeroDryRunAdapter`, hasil quote pertama memiliki impact `100` bps. Fixture diperbarui menjadi `9999` bps sebelum `buy`. Policy membatasi `200` bps. Hasil tetap `SIMULATION_ALLOWED` dan `SIMULATED`.

**Dampak:** hasil simulasi mengklaim lolos guard meskipun kondisi yang akhirnya dipakai melanggar policy. Masalah ini tetap berlaku jika quote diperbarui secara sah oleh provider.

**Perbaikan minimum:** gunakan satu snapshot quote immutable untuk pemeriksaan dan preview. Jika adapter perlu quote baru, jalankan guard terhadap quote baru sebelum memakainya. Ikat mint, amount, venue/pool, expiry, dan identitas quote. Tidak perlu menambahkan signer atau token otorisasi live untuk memperbaiki dry-run.

**Tes regresi:** perubahan impact, fee, min output, atau identitas quote setelah pemeriksaan harus ditolak atau memicu validasi ulang.

### F2 — P1: denominasi dan konteks frame hilang sebelum risiko/LLM

Lokasi: `src/intelligence/features.ts:229–235`; `src/intelligence/normalize.ts:43–52`; `src/core/models.ts:68–79`; `src/agents/screener/prompt.ts:54–79`.

`FeatureFrame` mengetahui `quoteMint`, `poolId`, dan window. Saat dikonversi menjadi `Observation`, konteks tersebut dibuang. Domain dan prompt hanya membawa nilai seperti `organicNetFlowRaw` dan `liquidityQuoteRaw`. Hash evidence membedakan frame, tetapi tidak memberi konsumen informasi satuan atau pasangan pasar. Prompt juga tidak menyertakan confidence dan rentang waktu metrik.

**Bukti:** ubah `quoteMint` pada frame fitur dan kedua titik likuiditas menjadi USDC, lalu normalisasi. Gunakan fakta token sintetis dan policy WSOL. `evaluateCandidate` tetap menghasilkan risiko `PASS` dan proposal mock `BUY`. Snapshot normalisasi tidak mempunyai `quoteMint`. Probe ini memakai respons LLM palsu; bukan bukti model nyata akan memilih BUY.

**Dampak:** data berbeda mata uang/pool/window dapat diperlakukan sebagai konteks yang sesuai. LLM tidak dapat menafsirkan nilai raw lintas token tanpa identitas satuan; guard juga tidak dapat membuktikan intelijen merujuk pasar yang sama dengan fakta risiko.

**Perbaikan minimum:** pertahankan konteks pasar dan rentang waktu pada kontrak observasi/snapshot. Batasi satu konteks per snapshot; tolak atau pisahkan observasi yang tidak cocok. Ikat fakta risiko dan quote ke konteks yang sama. Sertakan satuan/decimals yang tervalidasi atau representasi numerik dengan satuan eksplisit pada prompt, ditambah confidence/window.

**Tes regresi:** USDC versus WSOL, pool berbeda, window berbeda, dan denominasi tidak diketahui tidak boleh menyatu atau melewati pemeriksaan kesesuaian.

### F3 — P2: freshness memakai waktu sebelum operasi asynchronous

Lokasi: `src/application/simulate.ts:20–30`; pola serupa pada `src/application/evaluate.ts:108–114`.

`now` diberikan saat fungsi dimulai. Setelah menunggu provider, nilai yang sama dipakai untuk pemeriksaan. Waktu aktual saat guard berjalan bisa sudah melewati batas quote. Adapter Phase 3 menerima quote berumur hingga lima menit, sehingga pemeriksaan adapter tidak menggantikan batas guard yang hanya 15 detik.

**Bukti:** clock adapter bergerak dari `00:00:00` ke `00:00:20` selama pengambilan fakta. Jalur aplikasi menghasilkan `SIMULATED`. Memanggil guard dengan waktu `00:00:20` untuk input yang sama menghasilkan `BLOCKED`, dengan `QUOTE_REQUEST_INVALID` dan `QUOTE_MISSING_OR_STALE`.

**Dampak:** latensi provider mengurangi efektivitas TTL. Pemeriksaan expiry proposal di `evaluateCandidate` juga memakai waktu awal, bukan waktu setelah respons LLM.

**Perbaikan minimum:** injeksikan fungsi clock, baca ulang sesudah `await` dan tepat sebelum allowance/preview. Periksa ulang freshness/expiry yang relevan. Snapshot fakta tetap immutable; waktu pemeriksaan harus baru.

**Tes regresi:** quote/proposal yang kedaluwarsa selama menunggu harus gagal tertutup, menggunakan fake clock tanpa sleep panjang.

### F4 — P2: batas portofolio belum berlaku kumulatif antar-intent

Lokasi: `src/risk/portfolio.ts:33–59`; `src/risk/guard.ts:61–67,127`.

Guard hanya menyimpan ID intent yang telah dipakai. Intent baru dapat memakai snapshot portofolio yang sama berulang kali tanpa menambah pending exposure atau active orders. Selain itu, `maxPositionQuoteRaw` hanya membatasi order baru; tidak ada exposure per mint untuk memeriksa penambahan posisi yang sudah terbuka.

**Bukti:** satu instance guard, snapshot awal exposure `100000000`, batas total `500000000`, enam intent berbeda masing-masing `100000000`. Keenamnya mendapat `SIMULATION_ALLOWED`, meskipun allowance kumulatif bersama exposure awal mencapai `700000000`. Batas concurrent order `2` juga tidak berubah setelah allowance.

**Dampak:** simulasi siklus berulang bisa meloloskan eksposur dan jumlah order melebihi policy. Ini terjadi dalam satu proses; bukan hanya masalah restart/multi-worker. Preview ini belum menciptakan order sungguhan.

**Perbaikan minimum:** pemilik state simulasi harus memeriksa dan mencadangkan exposure/order secara atomik sebelum allowance, dengan pelepasan atau penyelesaian yang eksplisit. Gunakan state dalam memori dahulu untuk dry-run satu proses. Tambahkan exposure per mint, atau larang penambahan posisi sampai model itu tersedia. Definisikan kapan reservation dibatalkan jika preview gagal/null.

**Tes regresi:** intent berbeda paralel/sekuensial, penambahan mint yang sama, gagal preview, dan pelepasan reservation.

### F5 — P2: proposal dapat terikat ke snapshot yang tidak dilihat LLM

Lokasi: `src/agents/screener/agent.ts:49–55`; `src/application/evaluate.ts:111–112`.

Agent membangun prompt, menunggu LLM, kemudian mengambil `snapshotId` dan evidence dari objek input lagi. Evaluator membandingkan terhadap objek yang sama. TypeScript `Readonly` tidak membekukan objek runtime. Jalur `normalizeIntelligence` saat ini memang membekukan output, sehingga temuan memerlukan input dari port lain atau objek yang telah disalin menjadi mutable.

**Bukti:** gunakan `structuredClone` atas intelijen valid. Provider palsu merekam snapshot pada prompt lalu mengubah `snapshotId` input selama `await`. Proposal akhirnya berisi `snapshot:not-reviewed`, dan evaluator tetap menerima `PASS`/`BUY`.

**Dampak:** pembaruan state bersama dapat mengaitkan keputusan lama dengan snapshot baru. Ini bukan kemampuan prompt injection untuk langsung memodifikasi memori JavaScript; prasyaratnya ada pemanggil/provider lokal yang berbagi referensi mutable.

**Perbaikan minimum:** proyeksikan dan simpan snapshot immutable di batas evaluator/agent sebelum `await`. Gunakan ID/evidence tersimpan untuk membangun proposal dan memvalidasi hasil. Jangan bergantung pada semua implementasi port selalu menggunakan normalizer yang sama.

**Tes regresi:** mutasi kandidat, snapshot, dan evidence selama permintaan tidak boleh mengubah identitas keputusan.

### F6 — P3: beberapa jalur error HTTP tidak menutup response body

Lokasi: `src/providers/solana/discovery-rpc.ts:45–60`; `src/llm/chat-completions.ts:27–29`.

RPC melepaskan reader ketika body terlalu besar tanpa `cancel`. Kedua transport menolak status HTTP gagal sebelum membatalkan body. LLM sudah membatalkan reader ketika gagal di tengah pembacaan, tetapi tidak pada penolakan awal.

**Bukti:** fake response dengan `ReadableStream.cancel` sebagai pencatat. RPC menerima chunk melebihi 512 KiB dan LLM menerima HTTP 429. Keduanya melempar error, tetapi pencatat cancel tetap `false`.

**Dampak:** stream/koneksi dapat bertahan sampai abort/penutupan lain terjadi, menambah tekanan resource ketika provider berulang kali bermasalah. Probe membuktikan cleanup tidak dipanggil; bukan pengukuran kebocoran memori pada server nyata.

**Perbaikan minimum:** cancel body pada penolakan status/header dan cancel reader sebelum melepas lock ketika pembacaan gagal. Pertahankan error generik tanpa menyalin body ke log.

**Tes regresi:** 429/500, tipe konten salah, body terlalu besar, dan abort harus menutup stream.

## Celah integrasi dan batas yang memang belum dibangun

1. **Satu jalur aplikasi belum ada.** `src/cli.ts:17` hanya memanggil `runCycle` lama. Discovery, fitur, Screener, jurnal proposal baru, dan guard belum dirangkai bersama. Jangan menganggap `pnpm cycle` sebagai pengujian Phase 1–7. Tambahkan satu acceptance test offline yang menyambungkan parser discovery, feature fixture, normalizer, risk gate, mock LLM, jurnal, guard, dan preview. Tidak perlu scheduler atau API live.
2. **Saldo biaya native belum dimodelkan.** Guard memeriksa saldo aset quote terhadap amount; fee hanya dibandingkan dengan batas biaya. Tidak ada snapshot saldo native SOL untuk membayar fee/rent. Probe dengan saldo quote persis amount tetap lolos. Itu belum membuktikan wallet kekurangan SOL, tetapi sistem saat ini juga tidak bisa membuktikan kecukupannya. Lengkapi sebelum paper accounting yang realistis atau integrasi transaksi. WSOL/USDC dan native SOL harus dibedakan.
3. **Hard exclusion dari fitur belum ditetapkan.** Bundle/bot/dev/holder metrics dikirim ke LLM, tetapi belum menjadi ambang policy deterministik. Bila nilai tersebut akan menjadi batas keamanan, definisikan policy lokal beserta perilaku `null`; jangan meminta LLM menentukan apakah batas boleh dilewati. Audit tidak menetapkan angka atau strategi trading.
4. **Scoring strategi belum ada.** `OpportunityScore` baru tipe. Penundaan sesuai permintaan pengguna untuk mengesampingkan strategi; jangan menambahkan skor semu hanya untuk melengkapi diagram.
5. **Fakta on-chain, transaksi final, persistence, dan rekonsiliasi belum ada.** Fakta token/vault/portfolio tetap sintetis. Manifest program bukan pemeriksaan transaksi final. Cursor discovery serta idempotency tetap dalam memori. Batas ini terdokumentasi dan tidak boleh dipromosikan menjadi klaim siap live.
6. **Discovery sengaja terbatas.** Poller bootstrap di head, scan terbatas, dan berhenti saat gap/kapasitas. Belum cocok untuk observasi kontinu berintensitas tinggi tanpa backfill dan penyimpanan cursor. Tidak perlu memperluas protokol sebelum integrasi offline terbukti.
7. **GMGN belum aktif.** Kuota berbobot/cache/cooldown hanya fondasi yang diuji dengan fake clock. Jangan menyebutnya integrasi free API yang sudah bekerja atau mengaktifkan endpoint baru dalam patch audit.

## Penyederhanaan yang disarankan

- **Satukan jalur lama dan baru setelah acceptance test tersedia.** `domain.ts`, `risk.ts`, `screener.ts`, dan `cycle.ts` masih menopang CLI. Jangan langsung menghapusnya; pindahkan CLI ke jalur core/application yang telah diuji, lalu hapus model/risk ganda yang tidak dipakai.
- **Pindahkan validator alamat dari file I/O.** Modul risk, fitur, RPC, dan adapter mengimpor `validSolanaAddress` dari `src/input.ts`, yang juga mengimpor filesystem serta domain lama. Letakkan validator murni di core agar arah dependensi lebih jelas.
- **Tetapkan satu pemilik aturan dan unit.** TTL Phase 3 dan Phase 6 berbeda. Bedakan aturan adapter versus policy secara eksplisit; jangan menyalin guard ke setiap adapter. F1/F3 dapat diperbaiki dengan alur snapshot yang jelas.
- **Tunda port/model yang belum dipakai secara operasional.** `CandidateSource`, `IntelligenceSource`, `OpportunityScore`, state transition, dan SDK receipt mapper sebagian masih kontrak/rencana yang hanya diuji. Ukurannya kecil; tidak perlu framework tambahan, registri plugin, database besar, atau beberapa proses untuk menghidupkannya.
- **Perjelas README.** Pernyataan awal “tidak ada koneksi jaringan/LLM” benar untuk CLI default, tetapi terlalu luas untuk seluruh repo yang sudah memiliki kelas RPC dan transport LLM opsional.
- **Pertahankan pemisahan security.** Risk/guard, projection prompt, validasi evidence, abort, dan adapter dry-run bukan kerumitan yang perlu dibuang.

## Penilaian keamanan saat ini

- Transport jaringan ditemukan pada RPC discovery yang dikonfigurasi pemanggil dan dua endpoint LLM tetap: OpenAI/OpenRouter. GMGN gate menerima callback tetapi tidak memiliki endpoint sendiri.
- API key LLM diberikan eksplisit oleh pemanggil dan dikirim sebagai header ke service terpilih. Source tidak membaca private key atau mengirimkannya ke entitas lain. Error provider tidak mencetak body/header.
- Prompt dibangun dari bidang terpilih; metadata token mentah tidak diteruskan. Tidak ada tool eksekusi pada permintaan LLM.
- BUY tetap proposal; preview hanya menghasilkan `SIMULATED` dengan signature kosong. Mode CLI menolak `live`.
- Manifest tidak memiliki production dependencies; dependency pengembangan dipin dengan integrity pada lockfile. Ini memperkecil permukaan dependency, tetapi bukan sertifikasi bebas kerentanan.
- Tes import saat ini memeriksa pola teks/direct import. Tes itu bukan sandbox proses atau pembuktian transitif seluruh capability. Pertahankan batas sederhana dan tinjau ulang saat dependency/runtime bertambah.

## Urutan pekerjaan berikutnya

1. Perbaiki F1/F2/F3: konsistensi quote, konteks pasar, dan clock terbaru.
2. Perbaiki F4/F5 serta tambahkan tes regresi; reservation tetap sederhana dalam memori untuk simulasi.
3. Perbaiki cleanup transport F6 dan perjelas dokumentasi default CLI.
4. Tambahkan satu pengujian integrasi offline Phase 4/5/2/6/7/3 beserta jalur `SKIP`, timeout, konflik, dan guard menolak. Gunakan fake clock dan mock LLM.
5. Jalankan seluruh tes, typecheck, dan diff check. Setelah hasil ditinjau, lanjutkan scope Phase 8. Live trading tetap di luar pekerjaan ini.

Tidak diperlukan rewrite seluruh proyek. Perbaikan utama berada pada batas data dan koordinasi state antarmodul.
