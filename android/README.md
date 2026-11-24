# CNC Template Tracker — Android Studio (Capacitor Offline-First)

APK ini membundel seluruh folder `public/` langsung ke dalam aset APK melalui **Capacitor** (`android/app/src/main/assets/public/`), sehingga **`APP_URL` dan hosting HTTPS tidak lagi diperlukan**.

## Fitur Native di `MainActivity.kt`

- **Asset lokal offline-first:** Dijalankan melalui Capacitor `BridgeActivity` (`https://localhost`), mendukung IndexedDB dan CORS `POST text/plain` langsung ke Google Apps Script.
- **File Chooser (Kamera + Galeri + JSON):** `onShowFileChooser` + `FileProvider` sudah diimplementasikan sehingga upload foto sketch (kamera langsung / galeri) dan import backup JSON berjalan normal.
- **Penyimpanan Sketch Lokal:** Foto sketch disimpan sebagai file lokal di folder internal aplikasi (`files/sketches/`) via `Android.saveSketchFile` / `Android.readSketchFile` / `Android.deleteSketchFiles`.
- **Share QR Text:** `Android.shareQRText` membuka menu berbagi Android (WhatsApp, dll.).
- **QR Scanner & Print:** Pemindaian QR memakai ZXing (`Android.scanQr`) dan cetak memakai Android Print Framework (`window.print` / `Android.printCurrentPage` / `Android.printQRToPdf` — termasuk **Save as PDF** dan printer thermal yang terpasang di Android Print Service).

## Langkah Build APK

1. *(Opsional)* Isi URL Web App Apps Script di `public/config.js` sebelum sync. Anda juga bisa mengaturnya nanti langsung di dalam aplikasi lewat **⚙️ Pengaturan Server**.
2. Jalankan di root project:
   ```sh
   npm install
   npm run cap:sync
   ```
   Perintah ini menyalin seluruh folder `public/` ke `android/app/src/main/assets/public/` dan memperbarui konfigurasi Capacitor Android.
3. Buka folder `android/` di **Android Studio** (atau jalankan `npm run cap:open`).
4. Tunggu Gradle Sync selesai, lalu pilih **Build → Generate Signed Bundle / APK → APK** (gunakan keystore milik Anda sendiri).
5. Instal APK pada HP. Login sekali saat online untuk mengaktifkan token perangkat 30 hari; setelah itu aplikasi bisa dipakai penuh saat offline dan sync otomatis saat kembali online.

Jangan commit keystore, password keystore, atau URL/kredensial privat ke repositori publik.
