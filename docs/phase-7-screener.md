# Phase 7: Screener LLM sebagai pemberi proposal

Phase 7 menambahkan Screener LLM yang **opsional**. Siklus CLI bawaan tetap memakai fixture dan selalu menghasilkan `SKIP`; tidak ada provider LLM yang dibuat oleh CLI, API key dalam repo, wallet, signer, atau transaksi. Tes memakai respons palsu dan tidak memanggil internet.

## Alur

```text
TokenCandidate + TokenIntelligence + fakta risiko sintetis
  -> assessTokenRisk (Phase 6) dan pemeriksaan bukti/freshness
  -> snapshot prompt yang hanya memuat bidang terpilih
  -> satu permintaan LLM berbatas waktu, tanpa tools
  -> parse action/rationale/risks/evidenceIds
  -> kode lokal mengikat kandidat, snapshot, versi dan masa berlaku
  -> BUY atau SKIP sebagai proposal dan catatan keputusan
  -> guard Phase 6 masih wajib bila pratinjau dry-run dicoba
```

`src/screening/fixture-risk.ts` menghubungkan gerbang token Phase 6 ke `evaluateCandidate` untuk pengujian sintetis. Gerbang risiko dijalankan sebelum memanggil Screener. Data kritis `UNKNOWN` atau `REJECT` menghasilkan `SKIP`. `evaluateCandidate` membatasi waktu agen dan memanggil `AbortSignal` saat timeout; error, jawaban tidak valid, atau bukti di luar snapshot juga menghasilkan `SKIP` dan tetap dicatat.

`src/agents/screener/prompt.ts` hanya mengirim mint, ID snapshot/bukti dan metrik yang diizinkan. Nama token, sosial, metadata mentah, wallet, saldo, kunci, objek transaksi dan konfigurasi risiko tidak dikirim. Maksimum tiga lesson berstatus `APPROVED` dapat disertakan sebagai **data tidak tepercaya**; sumber lesson persisten dan riwayat performa belum dibangun sampai Phase 9. Teks lesson tidak pernah menjadi pesan sistem atau definisi tool. Instruksi prompt membantu model memahami batas ini, tetapi keamanan bergantung pada validator dan guard, bukan kepatuhan model.

`src/agents/screener/agent.ts` menerima keluaran model hanya dengan empat bidang: `BUY/SKIP`, alasan, kode risiko dan ID bukti. Bidang tambahan, aksi lain, ID bukti palsu, teks kontrol dan keluaran terlalu besar ditolak. Model tidak boleh memilih `candidateId`, `snapshotId`, `modelVersion`, `promptVersion`, `createdAt`, atau `expiresAt`; kode lokal mengisinya. `BUY` tetap proposal. Belum ada pemilihan ukuran posisi atau strategi kuantitatif.

## Provider opsional

`src/llm/chat-completions.ts` mendukung endpoint tetap OpenAI dan OpenRouter melalui Chat Completions. Keduanya memakai permintaan non-streaming dengan `response_format` JSON Schema strict dan `tool_choice: none`; tidak ada daftar tools. OpenRouter juga memakai `provider.require_parameters: true` agar model yang tidak mendukung parameter yang diwajibkan gagal. Endpoint HTTPS tetap, redirect ditolak, request/respons dibatasi ukurannya, durasi dan jumlah token dibatasi, dan error provider tidak menyalin body/URL/header ke log. Tidak ada retry otomatis. API key harus diberikan oleh pemanggil yang dipercaya saat runtime; tidak ada pembacaan env atau aktivasi otomatis dalam CLI.

Format ini mengikuti [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [OpenAI Chat Completions](https://developers.openai.com/api/reference/cli/resources/chat), dan [OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs). Dukungan JSON Schema bergantung pada model/provider yang dipilih. Jika tidak didukung atau respons terpotong, Screener gagal tertutup menjadi `SKIP`; tidak ada downgrade ke JSON longgar atau teks bebas.

## Batas keamanan dan fase berikutnya

- Fakta token Phase 6 masih klaim fixture. `PASS` tidak membuktikan kondisi on-chain. Karena itu proposal LLM Phase 7 tidak boleh dipakai untuk live trading.
- Prompt injection masih bisa memengaruhi alasan atau arah proposal. Pengendaliannya adalah proyeksi bidang, pemisahan role, tanpa tools, validasi skema/bukti, gerbang risiko dan guard deterministik. Jangan memberi Screener akses ke signer, adapter trading, tool eksekusi, atau konfigurasi kebijakan.
- Belum ada koneksi LLM ke CLI/penjadwal, konfigurasi model produksi, anggaran biaya harian, atau ledger keputusan persisten lintas proses. Phase 7 membuktikan kontrak dan alur fixture saja.
- Provider live dapat melihat data snapshot yang dikirim. Pilih penyedia dan kebijakan privasi secara sadar sebelum mengaktifkannya; jangan sertakan private key, API key, atau payload transaksi dalam prompt.

## Verifikasi

Jalankan `node --test tests/screener.test.ts`, `pnpm test`, dan `pnpm typecheck`. Tes meliputi prompt projection, lesson prompt injection, bukti palsu, bidang tool tak sah, risk gate sebelum LLM, timeout, respons terpotong, tool call, HTTP error, body terlalu besar, serta request OpenAI/OpenRouter dengan transport palsu. Tes tidak membuktikan kualitas sinyal trading atau kompatibilitas setiap model live.
