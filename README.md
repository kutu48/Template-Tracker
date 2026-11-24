# CNC Template Tracker — Google Sheets Edition 4.0.2

Clone dari project `cnc-template-tracker-v3.4.2.zip`, disesuaikan dengan requirement Google Sheets/OpenSheet, sketch Drive, tampilan history 5 terakhir, label QR template, dashboard lokasi, desktop, dan Android Studio.

## Fitur yang dipertahankan

- Input template multi-part, buyer, style/KP, sketch, distribusi, transfer/movement, storage, import lapangan, pencarian, dan hak akses.
- **Google Sheets** menjadi database. Baca/query utama memakai `https://opensheet.elk.sh/{SPREADSHEET_ID}/{TAB}`; tulis/login tetap melalui Google Apps Script Web App karena OpenSheet bersifat read-only.
- **Sketch/foto disimpan di folder Drive privat**, bukan base64 di sel Spreadsheet. Batas maksimal 1 MB per gambar ditegakkan di browser dan server.
- **History movement paling banyak 5** baris ditampilkan di beranda, halaman history, dan detail template. Filter tanggal/jenis/storage tetap ada.
- **Print QR Template**: QR berisi ID template; di bawah QR tercetak Style/KP, proses/part, lalu CT. CT dimasukkan saat akan mencetak dan tidak disimpan ke database.
- Cetak dari browser desktop/HP menggunakan dialog print perangkat: printer yang dikenali OS/driver atau **Save as PDF**. Pilihan thermal 58/80 mm tersedia. Printer thermal harus dikenali oleh layanan cetak perangkat.
- Dashboard menghitung template per lokasi dan merinci jumlah per Buyer + Style/KP.
- Android WebView wrapper untuk build APK di Android Studio, termasuk scanner QR dan Print Framework Android.

## Jalankan di desktop

Prasyarat: Node.js 20 atau lebih baru.

```sh
npm start
```

Buka `http://localhost:3000`. App ini client-side; data dibaca dari OpenSheet dan perubahan ditulis ke Apps Script. Pastikan perangkat punya akses internet.

## Setup Google Sheets + Apps Script

Ikuti [`SHEETS-SCHEMA.md`](SHEETS-SCHEMA.md) untuk header tab dan publikasi yang aman.

Ringkasnya:

1. Buat/copy Google Spreadsheet untuk project. Pada Spreadsheet, buka **Extensions → Apps Script** dan salin `apps-script/Code.gs` ke project yang terikat pada Spreadsheet.
2. Jalankan fungsi `setup()` satu kali dari editor Apps Script dan berikan izin Spreadsheet + Drive. Fungsi membuat header/master awal dan folder Drive privat; jika ada sketch lama, migrasikan ke Drive.
3. Isi baris pertama akun di tab `USERS` dengan role `super_admin` (password kuat, minimal 10 karakter). Tidak ada akun default `1234`. Password awal otomatis di-hash saat login pertama; password akun baru disimpan dalam bentuk hash.
4. **Publish hanya tab data yang aman dibaca** (`STORAGES`, `TEMPLATES`, `TEMPLATE_PARTS`, `MOVEMENTS`) ke web agar OpenSheet dapat membacanya. Jangan publish `USERS` atau `SKETCHES`, dan jangan ubah seluruh workbook menjadi bisa diedit publik.
5. Deploy Apps Script sebagai **Web app**, execute as pemilik, akses login Web App yang dibutuhkan perangkat pengguna. Aksi tulis memerlukan session hasil login; session berlaku maksimal 6 jam.
6. Koneksi pada clone ini sudah dikonfigurasi di `public/index.html`; panel pengaturan koneksi tidak ditampilkan pada layar login. Gunakan **Tes Koneksi** untuk memeriksa OpenSheet dan Apps Script.

Tab `SKETCHES` hanya menyimpan referensi file Drive internal. Tab itu tidak perlu dipublikasikan. Jangan memasukkan password, token, atau data sensitif ke tab yang diterbitkan untuk OpenSheet.

## Build APK

1. Host folder `public/` sebagai situs HTTPS.
2. Atur `APP_URL` di `android/gradle.properties` ke URL `index.html`.
3. Buka folder `android/` di Android Studio, lakukan Gradle Sync, lalu **Build → Generate Signed Bundle / APK → APK**.
4. Pada HP, printer tersedia bila printer/print service terdeteksi Android. Untuk PDF pilih **Save as PDF** pada dialog print.

Panduan lengkap: [`android/README.md`](android/README.md).

## Penting sebelum dipakai produksi

- OpenSheet hanya read/query; Apps Script menangani tulis, login, serta pembacaan foto Drive terproteksi.
- Jika menghubungkan Spreadsheet lama, periksa tab `USERS`: source lama pernah menggunakan akun demo `superadmin/admin/operator` dengan password `1234`. Hapus/ubah password tersebut sebelum deployment. Kode clone tidak lagi membuat akun default.
- Publikasi tab membuat nilai pada tab itu bisa dibaca publik. Publikasikan hanya data operasional yang memang boleh dibaca pengguna umum; bila perlu privasi lebih ketat, buat spreadsheet publik read-only terpisah dan salin view datanya.
- Perubahan yang baru ditulis bisa memerlukan refresh/sync sebelum tampak lewat layanan OpenSheet.
- Versi clone ini tidak membawa modul Storage Akrilik dari backend SQL V3.4 karena requirement yang diminta berfokus pada tracker template.

## Pemeriksaan lokal

```sh
npm run check
```

Pemeriksaan ini memvalidasi sintaks JavaScript frontend dan Apps Script serta mengecek fitur utama. Build APK tetap memerlukan Android Studio/SDK dan konfigurasi URL/keystore milik Anda.
