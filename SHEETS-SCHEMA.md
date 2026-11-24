# Google Sheets schema & setup

`setup()` membuat tab dan header berikut. Pertahankan nama tab/header persis karena OpenSheet memetakan kolom berdasarkan header.

| Tab | Header | Dipakai untuk |
|---|---|---|
| `USERS` | `username, password, role, name, active, createdAt, updatedAt` | Login dan peran. **Jangan publish tab ini.** |
| `STORAGES` | `code, name, area, createdAt, updatedAt` | Master lokasi/storage. |
| `TEMPLATES` | `id, buyer, stylekp, status, currentStorage, sketch, createdBy, createdAt, updatedAt, distributedAt` | Master template. `sketch` hanya penanda kosong/`DRIVE`, bukan isi gambar. |
| `TEMPLATE_PARTS` | `partId, templateId, part, size, qty, createdAt, status, currentStorage, distributedAt, updatedAt` | Part/proses pada template. |
| `MOVEMENTS` | `id, templateId, type, from, to, by, note, at` | Log pergerakan. UI hanya menampilkan maksimal 5 terbaru. |
| `SKETCHES` | `templateId, idx, seq, chunk, updatedAt` | Referensi Drive privat di kolom `chunk` dengan format `DRIVE_FILE:<fileId>`. **Jangan publish tab ini.** |

## Koneksi OpenSheet

Frontend membaca empat tab: `STORAGES`, `TEMPLATES`, `TEMPLATE_PARTS`, dan `MOVEMENTS`. Tab harus bisa dibaca lewat OpenSheet. Pilih publikasi tab yang diperlukan saja. `USERS` dan `SKETCHES` tetap privat; URL Apps Script menjalankan login/aksi tulis sebagai pemilik.

## Akun awal

Tidak ada kredensial default. Setelah `setup()` dijalankan, tambahkan satu row secara manual pada tab `USERS`, misalnya dengan kolom:

```text
username: nama-admin
password: password-kuat-minimal-10-karakter
role: super_admin
name: Nama Admin
active: TRUE
createdAt: (kosong atau tanggal saat ini)
updatedAt: (kosong atau tanggal saat ini)
```

Password awal plaintext hanya sementara di tab privat; setelah login pertama kode menggantinya dengan hash SHA-256 bersalt. User yang dibuat lewat aplikasi langsung tersimpan sebagai hash.

## Migrasi sketch lama

Saat `setup()` berjalan, Apps Script mengubah gambar data URL di `TEMPLATES.sketch` dan chunk lama di `SKETCHES` menjadi file di folder Drive `CNC Template Tracker - Sketches`, lalu menyimpan referensi Drive. Pastikan kuota Drive cukup dan beri izin Drive pada Apps Script. File tidak dibagikan publik; aplikasi mengambil foto lewat Apps Script setelah login.
