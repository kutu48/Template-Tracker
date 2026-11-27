# CNC Template Tracker — Offline-First Edition 5.0.0

Satu kode web **offline-first** di folder `public/` yang dibungkus sesuai platform (**PC folder mandiri + `Jalankan.bat`** dan **Android APK via Capacitor**). Semua data disimpan lokal terlebih dahulu di perangkat (IndexedDB + file sketch lokal di Android); **Google Sheets + Google Drive** digunakan khusus untuk sinkronisasi (update, soft-delete, delta download, dan upload antrean).

---

## Arsitektur Inti (PC & Android)

- **Satu kode web modular klasik (`public/`):** `index.html`, `styles.css`, `config.js`, `db.js`, `sync.js`, `vendor/qrcode.js`, dan `app.js` ditulis sebagai skrip & stylesheet klasik (tanpa `type="module"`, tanpa CDN, tanpa `fetch` ke file lokal, semua path relatif) sehingga berjalan langsung lewat `file://` di PC maupun dari asset internal APK via Capacitor.
- **UI Blue Navy + Background Putih, Navigasi Adaptif, & Dashboard Publik Tanpa Login:** Sebelum login, halaman utama hanya menampilkan **jumlah template per lokasi/storage** (tanpa detail isi template dan tanpa sidebar/bottom-nav). Setelah login (`🔐 Login`), muncul **Sidebar Kiri di Desktop (`≥ 1024px`)** atau **Bottom Bar + Drawer `☰ Menu` di Mobile**, dialog kustom Blue Navy (`uiAlert`/`uiConfirm`/`uiPrompt` tanpa blocking native `alert()`), serta akses penuh ke detail lokasi, filter interaktif, stok akrilik, dan seluruh menu.
- **Flow Bahan Baku Akrilik (`ACRYLIC_STOCKS` & `ACRYLIC_LOGS`):** Rekam stok akrilik masuk (`Panjang × Lebar` cm/mm, `Tebal mm`, warna, qty lembar). Saat input template, pilih **Pakai Stok Akrilik Baru** (otomatis mengurangi stok, mendukung desimal) atau **Sisa Akrilik Template Lain** (tercatat untuk traceability tanpa mengurangi stok baru).
- **Database lokal + antrean tulis (Outbox):** Semua operasi tulis (input template, stok akrilik, split distribusi, movement, storage, soft-delete, import lapangan, upload sketch) langsung disimpan lokal ke **IndexedDB** dengan **UUID klien** dan masuk antrean **Outbox**, lalu dikirim otomatis saat online dengan retry backoff eksponensial.
- **Delta Sync (`POST text/plain`):** Sinkronisasi memakai endpoint Google Apps Script sendiri (`action: "syncDelta"` dengan `since=timestamp` & `action: "pushOutbox"`), menggunakan `POST` dengan `Content-Type: text/plain;charset=utf-8` dan token di body JSON (respons JSON terbaca penuh — tanpa OpenSheet, tanpa JSONP, tanpa `POST no-cors`).
- **Soft Delete & Aturan Konflik:**
  - `MOVEMENTS` dan `ACRYLIC_LOGS` bersifat **append-only** (dedupe berdasarkan UUID klien).
  - `TEMPLATES`, `TEMPLATE_PARTS`, `STORAGES`, dan `ACRYLIC_STOCKS` memakai soft delete (`deleted: true`) dan aturan **update terbaru menang (Last-Write-Wins berdasarkan `updatedAt`)**.
- **Token perangkat 30 hari:** Login satu kali saat online menghasilkan token perangkat berumur **30 hari** (disimpan sebagai hash SHA-256 di tab privat `SESSIONS`), sehingga aplikasi tetap berjalan penuh saat offline.
- **Gambar Sketch:** Disimpan lokal (IndexedDB di PC, file lokal `files/sketches/` di Android), diunggah ke folder Google Drive privat (maks 1 MB/gambar) melalui antrean Outbox, serta diunduh on-demand lalu di-cache di perangkat.
- **Indikator Sync di UI:** Menampilkan status **Online/Offline**, jumlah antrean tertunda/gagal (bisa diklik untuk lihat/coba ulang), waktu sync terakhir, dan tombol **Sync**.
- **Backup & Restore Lokal:** Export/Import backup JSON di semua platform, ditambah **Auto-Backup otomatis ke folder pilihan** (File System Access API) di Edge/Chrome PC.

---

## Menjalankan di PC (Mandiri, Tanpa Node / Server)

1. Buka `public/config.js` dan isi `apiUrl` dengan URL Web App Apps Script Anda (atau atur langsung dari tombol **🔐 Login → ⚙️ Server**).
2. Klik dua kali **`Jalankan.bat`**.
3. Launcher akan otomatis membuka Microsoft Edge / Google Chrome dalam mode aplikasi (`--app`) langsung ke `public\index.html` dengan profil browser tersimpan di folder `browser-data\` di dalam folder aplikasi sendiri (tidak terhapus saat cache browser harian dibersihkan).
4. Sangat disarankan mengaktifkan **Auto-Backup ke Folder** di menu **Master & Backup**.

*(Opsional untuk development saja: `npm start` tetap tersedia untuk preview HTTP lokal di port `3000`.)*

---

## Setup Google Sheets + Apps Script

Ikuti [`SHEETS-SCHEMA.md`](SHEETS-SCHEMA.md) untuk struktur tab lengkap. Ringkasnya:

1. Buka Google Spreadsheet → **Extensions → Apps Script**, salin seluruh isi `apps-script/Code.gs`.
2. Jalankan fungsi `setup()` satu kali dari editor Apps Script dan berikan izin Spreadsheet + Drive. Fungsi ini membuat 9 tab (`USERS`, `SESSIONS`, `STORAGES`, `TEMPLATES`, `TEMPLATE_PARTS`, `MOVEMENTS`, `SKETCHES`, `ACRYLIC_STOCKS`, `ACRYLIC_LOGS`) serta melengkapi kolom akrilik pada `TEMPLATES` dan membuat folder Drive privat.
3. Tambahkan akun pertama di tab `USERS` dengan role `super_admin` dan password minimal 10 karakter (otomatis di-hash SHA-256 bersalt saat login pertama).
4. **Jangan publikasikan Spreadsheet ke web.** Tab `USERS`, `SESSIONS`, `SKETCHES`, dan data operasional tidak perlu dipublikasikan karena seluruh pembacaan dan penulisan berjalan lewat Apps Script Web App.
5. Deploy Apps Script sebagai **Web app** (*Execute as: Me*, *Who has access: Anyone*), lalu masukkan URL `/exec` ke `public/config.js` atau lewat menu **⚙️ Pengaturan Server**.

---

## Build APK Android (Capacitor + Android Studio)

Folder `public/` dibundel langsung di dalam APK menggunakan **Capacitor**, sehingga **tidak memerlukan `APP_URL` maupun hosting HTTPS**.

1. Pastikan `public/config.js` sudah diisi (opsional; bisa juga diatur dari UI di dalam aplikasi).
2. Salin aset web terbaru ke project Android:
   ```sh
   npm install
   npm run cap:sync
   ```
3. Buka folder `android/` di Android Studio (`npm run cap:open` atau Open folder `android/`), lakukan Gradle Sync, lalu **Build → Generate Signed Bundle / APK → APK**.
4. Fitur native & engineering Android di `android/` (`targetSdk = 35`, Gradle Wrapper `8.11.1`):
   - Safe-area & edge-to-edge Android 15 (`WindowCompat` + `WindowInsetsCompat` + CSS `env(safe-area-inset-*)`).
   - Runtime Camera Permission (`ActivityResultContracts.RequestPermission`) sebelum membuka kamera sketch (`onShowFileChooser`) maupun scanner QR ZXing (`Android.scanQr`).
   - Navigasi tombol Back fisik/gesture (`OnBackPressedCallback` → `window.handleHardwareBack()`) untuk menutup modal aktif atau kembali ke Dashboard sebelum keluar dari APK.
   - **Android Print Framework (`Android.printHtml`)** dengan lifecycle pembersihan `activePrintWebView`, konversi QR `<canvas>` ke PNG `<img>`, dan `PrintAttributes` eksplisit untuk A4, Thermal 58 mm, serta Thermal 80 mm.
   - Adaptive Launcher Icon Blue Navy (`@mipmap/ic_launcher`), penyimpanan sketch lokal `files/sketches/`, dan aturan R8/ProGuard (`proguard-rules.pro`) yang menjaga `@JavascriptInterface`.

Panduan lengkap: [`android/README.md`](android/README.md).

---

## Validasi Lokal

```sh
npm run check
```

Memvalidasi sintaks semua file skrip (`config.js`, `db.js`, `sync.js`, `vendor/qrcode.js`, `app.js`, dan `Code.gs`), memastikan bebas `type="module"`, CDN, OpenSheet, JSONP, `no-cors`, blocking `alert/confirm/prompt`, atau kredensial/URL hardcoded, serta memverifikasi konfigurasi PC & Capacitor Android.
