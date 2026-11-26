# Google Sheets Schema & Setup (Offline-First 5.0)

`setup()` di `apps-script/Code.gs` membuat dan memelihara seluruh tab berikut secara otomatis. **Jangan publikasikan Spreadsheet ini ke web** — semua komunikasi (login, delta sync, push outbox, sketch Drive) melewati endpoint `POST text/plain` Google Apps Script milik Anda dengan token perangkat di body JSON.

| Tab | Header | Keterangan |
|---|---|---|
| `USERS` | `username, password, role, name, active, createdAt, updatedAt` | Akun & peran (`operator`, `admin`, `super_admin`). **Privat, jangan dipublikasikan.** |
| `SESSIONS` | `tokenHash, username, role, name, deviceId, deviceName, createdAt, expiresAt, lastSeenAt, revoked` | Token perangkat 30 hari (disimpan sebagai hash SHA-256, bukan token mentah). **Privat.** |
| `STORAGES` | `code, name, area, createdAt, updatedAt, deleted` | Master lokasi/meja. Mendukung soft delete (`deleted = TRUE`) & LWW (`updatedAt`). |
| `TEMPLATES` | `id, buyer, stylekp, status, currentStorage, sketch, createdBy, createdAt, updatedAt, distributedAt, deleted, acrylicSource, acrylicId, acrylicQty, acrylicSourceTemplateId, acrylicSpec` | Master template (ID UUID dari klien) + referensi bahan baku akrilik (`NEW_SHEET` atau `LEFTOVER`). |
| `TEMPLATE_PARTS` | `partId, templateId, part, size, qty, createdAt, status, currentStorage, distributedAt, updatedAt, deleted` | Part/proses per template (UUID klien). Mendukung split distribution, auto-merge, soft delete, & LWW. |
| `MOVEMENTS` | `id, templateId, type, from, to, by, note, at` | Log pergerakan **append-only** (dedupe berdasarkan UUID `id` klien). |
| `SKETCHES` | `templateId, idx, seq, chunk, updatedAt, deleted` | Referensi file Drive privat (`DRIVE_FILE:<fileId>`). **Privat.** |
| `ACRYLIC_STOCKS` | `id, length, width, unit, thicknessMm, color, qtyIn, qtyUsed, qtyAvailable, note, createdBy, createdAt, updatedAt, deleted` | Stok bahan baku akrilik (Panjang × Lebar × Tebal mm). Otomatis berkurang saat dipakai template baru (`NEW_SHEET`). |
| `ACRYLIC_LOGS` | `id, acrylicId, templateId, sourceType, sourceTemplateId, qty, sizeLabel, by, note, at` | Riwayat **append-only** akrilik masuk (`IN`), pemakaian stok baru (`NEW_SHEET`), dan pemakaian sisa template lain (`LEFTOVER`). |

## Akun Awal

Tidak ada password default. Setelah `setup()` dijalankan satu kali dari editor Apps Script, tambahkan 1 baris di tab `USERS`:

```text
username: admin
password: password-kuat-minimal-10-karakter
role: super_admin
name: Super Admin
active: TRUE
createdAt: (boleh kosong)
updatedAt: (boleh kosong)
```

Password plaintext sementara pada baris awal akan otomatis diganti menjadi hash `sha256$<salt>$<digest>` pada login pertama. Semua user yang dibuat lewat aplikasi langsung tersimpan dalam bentuk hash.

## Token Perangkat 30 Hari & Offline

- Saat login online, backend membuat token acak, menyimpan hash SHA-256 ke tab `SESSIONS` dengan masa berlaku **30 hari**, dan mengirim token ke perangkat.
- Perangkat menyimpan sesi di IndexedDB sehingga pengguna tetap bisa membuka aplikasi, menambah/mendistribusi/memindahkan template, dan memotret sketch saat offline.
- Saat tombol **Logout** ditekan (ketika online) atau akun dinonaktifkan (`active = FALSE`), token perangkat terkait langsung dicabut (`revoked = TRUE`).

## Migrasi dari Versi Lama (v4.x)

1. Salin `apps-script/Code.gs` versi 5.0 ke project Apps Script yang terikat pada Spreadsheet.
2. Jalankan `setup()` sekali — header baru (`deleted` & tab `SESSIONS`) ditambahkan tanpa menghapus data lama, dan sketch base64 lama otomatis dipindahkan ke folder Drive `CNC Template Tracker - Sketches`.
3. Deploy sebagai **Web app → New version** (*Execute as: Me*, *Who has access: Anyone*).
4. Anda dapat mematikan *Publish to web* pada tab Spreadsheet jika sebelumnya pernah diaktifkan untuk OpenSheet.
