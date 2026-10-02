# Phase 5: intelijen deskriptif

Phase 5 menambahkan pembangun fitur **baca-saja** dari rekaman sintetis. Modul ini tidak menemukan token, memanggil API, mengubah kebijakan risiko, memberi sinyal beli, atau mengirim transaksi. CLI tetap memakai fixture sebelumnya dan menghasilkan `SKIP`. Penyambungan sumber data langsung memerlukan pemeriksaan kontrak dan keamanan tersendiri.

## Aliran dan batas modul

`FixtureFeatureProvider` memuat `fixtures/features.json` (maksimum 256 KiB, empat frame), lalu `parseFeatureFrame` menolak bidang asing, alamat tidak valid, unit ambigu, ID berulang, window tidak selaras, dan pergantian pool/quote. `deriveFeatureObservations` menghitung fakta dan mengubahnya menjadi lima kategori `Observation` Phase 2. `collectIntelligence` dan `normalizeIntelligence` tetap pemilik timeout, usia data, konflik, provenance, dan snapshot. Seluruh hasil adalah data tidak tepercaya. Tidak ada jalur dari modul ini ke signer atau `TradingAdapter`.

Satu frame mengikat **satu mint, pool, quote mint, dan waktu akhir**. Window saat ini dan sebelumnya masing-masing 1–15 menit, berdampingan, dan sama panjang. Snapshot holder dan cadangan quote memiliki waktu eksplisit yang harus tepat cocok dengan akhir window terkait; nilai historis tanpa window sebelumnya ditolak. Trade memakai `quoteRaw` dalam unit terkecil dari quote mint yang sama. Rasio memakai basis poin (10.000 = 100%). Perubahan dapat negatif. `null` berarti bukti atau penyebut tidak tersedia; `0` berarti pengukuran tersedia dan nilainya nol. `coverageBps` dan `confidenceBps` adalah penilaian sumber data, bukan bukti kebenaran. Sumber langsung kelak harus mengukur dan memvalidasi keduanya, serta memastikan wallet, holder, dan likuiditas berasal dari slot/waktu yang konsisten dengan frame. Timestamp dari provider tetap perlu dibuktikan terhadap sumber on-chain; pemeriksaan skema saja tidak membuktikannya.

## Fitur yang dihitung

| Kelompok | Nilai Phase 5 | Syarat dan makna |
| --- | --- | --- |
| Organic | Jumlah buyer, pertumbuhan buyer, volume beli/jual, net flow, percepatan volume | Proksi konservatif: peserta dengan fakta `bot` dan `funder` lengkap; bot dan wallet yang berbagi funder dikeluarkan. Funder tunggal dan label non-bot **tidak membuktikan** perilaku organik. `organicScore` tetap `null` sampai ada kalibrasi berbasis outcome. |
| Wallet | Persentase buyer berusia ≤7 hari, jumlah kelompok funder bersama, pola ukuran beli identik di ≥3 wallet, jumlah buyer berlabel smart money | Usia/funder/smart money harus berasal dari provider tervalidasi. Pola ukuran hanya heuristik. Fakta tidak lengkap menghasilkan `null` untuk metrik yang bergantung padanya. |
| Manipulation | Porsi volume bundle terbesar, porsi beli berukuran identik, jumlah wallet dengan beli dan jual berukuran sama, porsi saldo bot | `bundleId` harus tersedia pada **semua** trade untuk menghasilkan angka; `null` secara eksplisit berarti trade diketahui tidak ber-bundle. Ukuran sama dan round trip hanyalah indikator awal. `washTradingProbabilityBps` tetap `null` sampai ada model tervalidasi. |
| Holder | Pertumbuhan jumlah owner, konsentrasi 10 owner teratas, porsi dev, porsi owner terbesar | Token account digabung menurut owner. Semua saldo akun yang disuplai harus tepat sama dengan `supplyRaw`; bila parsial atau vault yang diklaim tidak cocok dengan bukti, **semua** metrik holder dan porsi bot menjadi `null`. Penyebut ialah supply dikurangi saldo vault yang teridentifikasi. `previousHolderCount` harus bertanggal akhir window sebelumnya dan memakai definisi owner yang sama. |
| Liquidity | Cadangan quote, pertumbuhan cadangan, volume trade/cadangan | Hanya satu pool dan quote yang sama boleh dibandingkan. Cadangan quote **bukan** valuasi total likuiditas. `priceImpactBps` tetap `null` karena memerlukan quote eksekusi yang diverifikasi. |

### Bukti vault dan kualitas sumber

Label `claimedVault`, besarnya saldo, atau alamat yang terlihat seperti pool tidak cukup untuk mengecualikan akun dari konsentrasi. Frame harus menyertakan tautan pool ID, program pool yang didukung, owner akun pool, vault pada state pool, authority vault, mint akun token, dan owner program token yang saling cocok. Pencocokan ini adalah **pemeriksaan struktur atas data yang diberikan provider**, bukan verifikasi kriptografis terhadap jaringan. Fixture sintetis memakainya untuk menguji batas perhitungan. Sebelum memakai holder untuk kebijakan risiko, adapter on-chain harus mengambil dan mendekode akun pool serta token secara independen pada commitment/slot yang sesuai, memvalidasi ID program dan state, lalu menolak data yang tidak lengkap. Pump.fun bonding curve, PumpSwap, Raydium selain CPMM, dan Meteora belum punya aturan vault Phase 5; jangan menganggapnya tervalidasi oleh pemeriksaan ini.

## Provenance dan kegagalan aman

Setiap kategori memiliki evidence ID yang memuat `feature-v1`, ID frame, kategori, dan hash konten. Mengubah konten mengubah snapshot. Nilai yang kedaluwarsa (>5 menit), bertentangan, atau tidak didukung diperlakukan oleh normalizer sebagai tidak tersedia. Data yang hilang tidak boleh berubah menjadi skor aman atau izin trade. Pemeriksaan risiko token/portofolio yang sesungguhnya adalah pekerjaan Phase 6; Phase 5 tidak membuat keputusan risiko.

`fixtures/features.json` adalah data **sintetis**, bukan snapshot on-chain. Alamat dan label di dalamnya hanya untuk tes. Tidak boleh digunakan sebagai bukti bahwa suatu token aman. GMGN Free tetap opsional dan nonaktif; tidak ada endpoint, key, atau panggilan jaringan baru. Sebelum GMGN dipakai, kontrak endpoint, batas kuota bersama lintas proses, format dan provenance respons, serta fallback harus diverifikasi.

## Verifikasi

Jalankan `node --test tests/intelligence-features.test.ts`, `node --test tests/*.test.ts`, dan `pnpm typecheck`. Tes Phase 5 mencakup window selaras, pool switch, sybil satu funder, label bot, bundle, pola ukuran, round trip, fakta hilang, daftar holder parsial, bukti vault yang tidak cocok, bidang rahasia tak dikenal, stale data, dan versi/hash bukti. Semua metrik di atas tetap bersifat deskriptif; fixture tidak membuktikan ketepatan klasifikasi bot, dev, funder, atau smart money dari provider nyata.

## Sebelum Phase 6

Tetapkan definisi data minimum yang diwajibkan untuk hard risk gate; pisahkan metrik teramati, label heuristik, dan nilai `UNKNOWN`. Validasi sumber on-chain dan waktu/slot untuk supply, vault, pemilik, cadangan, serta trade sebelum menggunakan fitur ini untuk keputusan. Lalu uji gerbang risiko dengan data parsial dan manipulatif; unknown harus memblokir izin eksekusi.

## Pembaruan konteks pasar

`FeatureFrame.quoteDecimals` wajib. Setiap observasi membawa `market` berisi `poolId`, `quoteMint`, `quoteDecimals`, `windowFrom`, dan `windowTo`. Normalizer memasukkan konteks ke snapshot/hash, menolak input tanpa konteks, dan mengosongkan metrik dengan konflik `market` jika konteks berbeda. Data dari window/pool berbeda harus dipisah atau disejajarkan sebelum normalisasi. Decimals dalam fixture tetap klaim sintetis; provider nyata harus membuktikannya dari akun mint.
