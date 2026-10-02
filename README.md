# Memecoin Bot 19

Fondasi bot Solana yang **belum bisa melakukan trading**. Versi ini menjalankan satu siklus observasi dari berkas contoh, memvalidasi data, menerapkan gerbang risiko deterministik, dan mencatat keputusan `SKIP`. CLI default tidak membuka koneksi jaringan atau LLM. Repo memiliki transport RPC baca-saja dan LLM opsional yang hanya aktif bila dibuat eksplisit; belum ada wallet, signer, SDK trading, atau transaksi.

## Menjalankan

Perlu Node.js 24 atau lebih baru. Siklus dan tes runtime tidak memerlukan instalasi paket. Pemeriksaan tipe memerlukan dependensi pengembangan yang dipin di `pnpm-lock.yaml`; instal dengan `pnpm install --frozen-lockfile --ignore-scripts` lalu jalankan `pnpm typecheck`.

```sh
node src/cli.ts
node --test tests/*.test.ts
```

Masukan bawaan adalah `fixtures/candidates.json`. Berkas lain dapat dipakai dengan `node src/cli.ts path/to/candidates.json`. Keluaran ringkas muncul di terminal; rekaman keputusan terstruktur ditambahkan ke `data/decisions.jsonl` (diabaikan Git). Berkas masukan dibatasi 256 KiB dan 100 kandidat. Nilai di luar format yang ditentukan ditolak.

Status `PASS` pada gerbang risiko hanya berarti data contoh memenuhi pemeriksaan awal. Data contoh tidak membuktikan kondisi on-chain. Semua kandidat tetap `SKIP` karena strategi, data langsung, dan otorisasi eksekusi belum tersedia. Jangan masukkan private key atau kredensial ke berkas masukan.

## Phase 1

`src/core/` berisi model, satuan, skema proposal agen, dan aturan transisi status. `src/application/ports.ts` mendefinisikan antarmuka baca-saja dan jurnal keputusan. Mode runtime hanya `fixture`; `BOT_MODE=live` ditolak. Tes batas impor memastikan core, application, dan screener tidak mengimpor SDK, signer, jaringan, atau eksekusi. Proposal `BUY` pada tes kontrak tetap data tidak tepercaya dan tidak dapat dikirim sebagai transaksi.

Rancangan lengkap dan batas keamanan ada di [audit arsitektur](docs/architecture-audit.md). Langkah selanjutnya adalah menambahkan adapter data baca saja beserta verifikasi sumber, lalu replay/paper mode. Eksekusi live memerlukan desain dan peninjauan terpisah.

GMGN Agent API Free dipilih sebagai **provider intelijen tambahan**, bukan syarat bot berjalan. Adapter GMGN belum aktif; gunakan API key dengan izin baca saja saat implementasi nanti. Batas Free berbobot per endpoint, sehingga adapter perlu kuota bersama, cache, cooldown dan fallback. Rinciannya ada di bagian 8 audit arsitektur.

## Phase 2

`src/providers/fixture.ts` memuat observasi contoh dengan batas ukuran dan skema ketat. `src/intelligence/normalize.ts` menyatukan fakta ke `TokenIntelligence`, menyimpan asal dan waktu data, menandai nilai yang bertentangan, dan menghitung ID snapshot dari isinya. Fakta kedaluwarsa, kategori tanpa nilai, atau nilai bertentangan tidak dapat meloloskan gerbang evaluasi. `src/intelligence/collect.ts` memberi batas waktu per provider dan mengabaikan respons rusak tanpa mencatat isi respons atau pesan kesalahannya. Contoh data ada di `fixtures/observations.json`; tes kontraknya di `tests/providers.test.ts`.

`src/providers/gmgn/quota.ts` hanya berisi simulasi pengatur kuota berbobot, jeda antarpermintaan, cache menurut rute/token/versi skema, deduplikasi, dan cooldown untuk tes. Belum ada URL, klien HTTP, API key, atau adapter GMGN aktif. `InMemoryWeightedQuota` hanya berlaku dalam satu proses. Sebelum mengaktifkan GMGN, periksa endpoint, bobot dan izin akun yang berlaku, lalu ganti penyimpanan kuota dengan ledger atomik yang digunakan bersama semua proses pemakai key. Respons GMGN tetap perlu adapter skema khusus dan tes kontrak. CLI tetap menggunakan fixture Phase 1 dan hanya menghasilkan `SKIP`.

## Phase 3

`src/application/trading-adapter.ts` mendefinisikan kontrak trading **khusus dry-run**. `src/execution/fnzero/dry-run.ts` memetakan intent ke bentuk pratinjau FnZero dan memeriksa quote serta saldo dari fixture lokal. `buy`/`sell` hanya mengembalikan `SIMULATED` tanpa signature; CLI tetap fixture-only. Tidak ada SDK FnZero, wallet, signer, RPC, atau transaksi yang dijalankan. Detail batasan dan keputusan yang masih terbuka ada di [catatan Phase 3](docs/phase-3-dry-run.md).

## Phase 4

`src/discovery/` mengenali event token baru Pump, migrasi PumpSwap, dan pool Raydium CPMM dari transaksi Solana yang sudah `finalized`. `src/providers/solana/discovery-rpc.ts` menyediakan dua metode RPC baca-saja. Polling harus dipanggil secara eksplisit dan cursor masih dalam memori; restart dan gap memerlukan backfill sebelum pemantauan kontinu. CLI siklus utama belum memakai discovery jaringan dan tetap `SKIP`. Rincian aliran, sumber IDL, dan batasannya ada di [catatan Phase 4](docs/phase-4-discovery.md).

## Phase 5

`src/intelligence/feature-frame.ts` memvalidasi frame trade, wallet, holder, dan cadangan quote untuk satu pool dengan dua window yang selaras. `src/intelligence/features.ts` menghitung metrik deskriptif yang tersedia dan meninggalkan skor organik, probabilitas wash trading, serta price impact sebagai `null`. Provider `src/providers/feature-fixture.ts` hanya membaca `fixtures/features.json` yang sintetis; tidak ada API atau trading aktif. Bukti vault dalam fixture diperiksa konsistensi strukturnya, tetapi belum diverifikasi terhadap jaringan. Detail metode, batas keamanan, dan tes ada di [catatan Phase 5](docs/phase-5-intelligence.md). CLI tetap `SKIP`.

## Phase 6

`src/risk/` memuat kebijakan deterministik untuk fakta token, batas portofolio dan guard simulasi. `src/application/simulate.ts` hanya mengizinkan pratinjau BUY melalui adapter dry-run setelah semua gerbang lolos. Data dan ambang dalam tes bersifat sintetis; manifest program belum memvalidasi transaksi final. Tidak ada otorisasi live, signer, atau pengiriman transaksi. CLI tetap `SKIP`. Detail batasan dan pengujian ada di [catatan Phase 6](docs/phase-6-risk-engine.md).

## Phase 7

`src/agents/screener/` menyiapkan prompt data terbatas dan mengubah jawaban LLM menjadi proposal `BUY/SKIP` yang tervalidasi. `src/llm/` menyediakan provider OpenAI/OpenRouter yang hanya aktif bila dibuat secara eksplisit oleh pemanggil tepercaya; tes menggunakan transport palsu tanpa API key nyata. `src/screening/fixture-risk.ts` menghubungkan gerbang Phase 6 sebelum Screener dalam tes. Timeout, respons rusak, atau bukti tidak cocok menjadi `SKIP`. CLI tetap fixture-only dan `SKIP`; proposal LLM tidak mempunyai akses trading. Detailnya ada di [catatan Phase 7](docs/phase-7-screener.md).

## Patch audit Phase 1–7

Enam temuan audit telah dipatch pada alur simulasi. Lihat [catatan patch](docs/phase-1-7-patch.md) untuk kontrak data yang berubah dan batas reservation satu proses. `node --test tests/pipeline.test.ts` menguji sambungan discovery fixture, fitur, normalisasi, risk gate, mock LLM, jurnal, dan preview tanpa jaringan. CLI tetap menjalankan contoh `SKIP`; tes integrasi ini bukan mode live atau paper trading penuh.

## Phase 8

`src/positions/` memantau pemicu exit deterministik dan memvalidasi bukti fill sintetis. `src/agents/manager/` hanya menghasilkan proposal `HOLD/REDUCE/EXIT`; hard exit melewati LLM. Guard SELL di `src/risk/sell-guard.ts` memeriksa posisi, jumlah, quote, saldo, dan intent sebelum preview dry-run. Preview tidak mengubah posisi atau menjadi transaksi; hasil tanpa rute tetap belum terselesaikan. Lihat [catatan Phase 8](docs/phase-8-manager.md). CLI tetap `SKIP` tanpa wallet atau transaksi.
