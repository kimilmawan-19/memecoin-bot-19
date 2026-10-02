# Phase 9 — Researcher dan lesson (fixture/offline)

Phase 9 menambahkan jalur riset terpisah dari siklus trading. `LlmResearcherAgent`
membaca outcome `ClosedTrade` yang sudah direkonsiliasi dan fitur yang tercatat
sebelum posisi dibuka. Ia mengusulkan satu hipotesis setup yang menguntungkan,
contoh trade menang, contoh trade rugi yang menyangkal hipotesis, dan usulan
threshold opsional. Semua hasil tetap `PROPOSED`; tidak ada perubahan policy
atau eksekusi otomatis.

## Alur dan pemilik data

1. `learning/research.ts` memproyeksikan maksimal 100 case fixture ke bentuk
   tetap, membekukan salinannya, dan menolak trade belum direkonsiliasi,
   timestamp fitur setelah pembukaan, ID duplikat, data rusak, serta dataset
   dengan kurang dari 20 case atau kurang dari lima menang dan lima rugi.
2. `learning/research.ts` menghitung hitungan serta min/median/max tiap metrik
   untuk kelompok menang dan rugi. `agents/researcher/prompt.ts` mengirim
   ringkasan itu, ID trade, label WIN/LOSS/FLAT, dan empat metrik numerik.
   Wallet, mint, signature, teks provider,
   objek eksekusi dan PnL mentah tidak dikirim. Respons LLM dibatasi skema.
3. `agents/researcher/agent.ts` dan validator mengikat bukti ke ID trade
   yang benar: minimal tiga trade menang untuk dukungan dan dua trade rugi
   sebagai counterexample. Usulan threshold hanya boleh menyebut salah satu
   metrik yang tersedia pada semua trade yang dikutip. Model tidak memilih
   status persetujuan, ID laporan, versi, atau waktu.
4. `persistence/lesson-journal.ts` menyimpan proposal dan review sebagai
   berkas terpisah yang dibuat sekali dengan izin file terbatas. Review dari
   alur operator tepercaya dapat menandai `APPROVED` atau `REJECTED`. Hanya
   lesson `APPROVED` yang dikembalikan untuk dipasok ke Screener; Screener
   sendiri tetap memperlakukan teks lesson sebagai data tidak tepercaya.

Jurnal ini bukan ledger posisi, layanan autentikasi reviewer, atau penyimpanan
transaksional lintas proses. Berkas rusak membuat pembacaan gagal, bukan
menghasilkan lesson yang dianggap sah. Panggilan `recordReview` harus
diletakkan di belakang autentikasi operator jika kelak ada aplikasi/layanan.

## Batas pembuktian

Dataset saat ini fixture. Lolosnya batas jumlah sampel, adanya counterexample,
dan validnya timestamp **tidak membuktikan** aturan punya keunggulan statistik.
Usulan threshold tidak menunjuk langsung ke field policy aktif dan tidak
pernah diterapkan otomatis. Evaluasi holdout, replay historis, ledger closed
trade otoritatif, dan audit kualitas sinyal termasuk Phase 10 atau sesudahnya.
Tidak ada CLI riset terjadwal, wallet, signer, SDK submit, atau akses private key.
CLI utama tetap menghasilkan `SKIP`.

## Verifikasi

Jalankan `node --test tests/researcher.test.ts`, `pnpm test`, dan
`pnpm typecheck`. Tes menutup kebocoran fitur masa depan, ukuran sampel,
outcome belum final, bukti palsu, output seperti tool call, prompt projection,
review terpisah, duplikasi proposal/review, serta pembacaan jurnal rusak.
