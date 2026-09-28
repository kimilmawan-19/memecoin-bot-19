# Phase 4: discovery baca-saja

Phase 4 menambahkan jalur **poll manual** untuk mengubah transaksi Solana yang sudah `finalized` menjadi kandidat dan event discovery. Tidak ada scheduler, koneksi wallet, signer, SDK trading, order, atau transaksi. CLI siklus utama tetap memakai fixture dan menghasilkan `SKIP`.

## Aliran dan batas tanggung jawab

1. `HttpDiscoveryRpc` hanya menyediakan `getSignaturesForAddress` dan `getTransaction` melalui HTTPS. Semua permintaan memakai komitmen `finalized`; `getTransaction` memakai `jsonParsed` dan meminta dukungan versi transaksi sampai v1. Versi lebih baru harus ditinjau sebelum dinaikkan.
2. `DiscoveryPoller` membaca signature terbaru untuk program Pump dan Raydium CPMM. Panggilan pertama menyimpan head sebagai cursor **dalam memori** tanpa mengeluarkan histori. Panggilan berikutnya memproses transaksi sejak cursor, dari slot lebih tua ke lebih baru. Urutan antartransaksi dalam slot yang sama tidak dijamin; indeks kandidat tidak bergantung pada urutan tersebut.
3. `parseDiscoveryTransaction` menerima instruksi dengan `programId`, discriminator, posisi akun, dan status transaksi yang cocok. Log, nama token, dan metadata bukan bukti event. Instruksi CPI pada `innerInstructions` juga diperiksa.
4. `DiscoveryIndex` menyatukan event menurut mint, menyimpan evidence ID per instruksi, dan menerima urutan migrasi yang tiba sebelum event penciptaan. Raydium pool creation adalah sinyal pool Raydium; **bukan** bukti migrasi Pump. Migrasi Pump dipetakan ke PumpSwap.

Parser mengenali `create`, `create_v2`, `migrate`, `migrate_v2` dari [IDL Pump resmi](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json) dan `initialize`, `initialize_with_permission` dari [IDL Raydium CPMM resmi](https://github.com/raydium-io/raydium-idl/blob/master/raydium_cpmm/raydium_cp_swap.json). Posisi akun dan discriminator harus diaudit ulang setelah perubahan program. Hanya pasangan Raydium dengan tepat satu quote mint WSOL atau USDC yang menghasilkan kandidat. Pool lain tidak ditebak identitas mintnya.

## Keandalan dan batasan

- Setiap poll dibatasi 1–100 signature baru secara total, 101 signature per halaman, respons RPC 512 KiB, timeout HTTP 10 detik, dan indeks 10.000 evidence/kandidat. Tidak ada loop otomatis yang menghabiskan kuota RPC.
- Cursor baru disimpan setelah semua sumber dibaca dan semua transaksi tersedia serta terurai. Saat RPC gagal, transaksi belum tersedia, jumlah signature melebihi batas, atau cursor hilang dari halaman, poll gagal dan cursor tidak maju. Kasus gap memerlukan backfill manual; proses tidak diam-diam melompat ke head.
- State hanya dalam memori. Restart melakukan bootstrap ulang dan melewatkan event selama bot mati. Penyimpanan cursor, pagination/backfill, autentikasi RPC, kebijakan rate limit, dan resiliensi multi-proses belum disediakan. Karena itu discovery ini belum cocok untuk pemantauan produksi kontinu.
- Timestamp memakai `blockTime` dari transaksi. Jika tidak tersedia atau metadata transaksi rusak, poll gagal. Event hanya memberi kandidat; kelayakan token tetap `UNKNOWN` sampai intelijen dan risiko deterministik diverifikasi pada fase berikutnya.
- `HttpDiscoveryRpc` menerima endpoint HTTPS yang diberikan aplikasi; jangan masukkan kredensial ke kode, fixture, log, atau URL yang dibagikan. URL dengan username/password, query, dan fragment ditolak. Isi error dan respons RPC tidak dicetak.

## Verifikasi

Jalankan `node --test tests/discovery.test.ts`, `pnpm test`, dan `pnpm typecheck`. Replay test mencakup discriminator dan indeks akun IDL, CPI, data rusak, deduplikasi, migrasi sebelum penciptaan, urutan lintas program, gangguan RPC, cursor gap, backpressure, dan transaksi yang belum tersedia. Fixture `fixtures/phase4-onchain.json` menyimpan **potongan instruksi publik** dari tiga transaksi finalized: [Pump create_v2](https://solscan.io/tx/5CSa7WnTAymTpGK44M661r8GdTCRbL4DXhMpK7WZeWKUoy1taFsThTAoHbzw6irYZbY15AQw48XNKzogNGFnbk9D), [Pump migration](https://solscan.io/tx/5zwJA9Ef2AeCU6szQaREHKZT3NfUUXP4exe6biw7D4fXYxUcT2WCpYSVuP2oFZgkeCGi4Ni16jbVSzrme6SRRVeF), dan [Raydium CPMM initialization](https://solscan.io/tx/4bveiR7H29FTCGXBcSw4hd1ErGhapEUKSau8nXxEnNckHr9V2ifWQGh1CyrhWwqRYMPeDVm3SNwFW9uXn2RB1i4q). Test merekonstruksi amplop transaksi minimal di memori; tidak ada request jaringan saat tes. Smoke test RPC publik mengungkap transaksi v1 yang ditolak oleh konfigurasi v0 awal; adapter sekarang meminta dukungan sampai v1.

Sebelum mengaktifkan pemantauan kontinu, tambahkan cursor dan indeks persisten yang atomik, pagination/backfill, pengaturan laju sesuai penyedia RPC, serta replay transaksi nyata yang sudah dianonimkan. Jangan menghubungkan keluaran discovery langsung ke jalur trading.
