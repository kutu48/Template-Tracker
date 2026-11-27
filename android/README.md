# CNC Template Tracker — Android Studio (Capacitor Offline-First)

APK ini membundel seluruh folder `public/` langsung ke dalam aset APK melalui **Capacitor** (`android/app/src/main/assets/public/`), sehingga **`APP_URL` dan hosting HTTPS tidak lagi diperlukan**.

## Fitur Native di `MainActivity.kt`

- **Asset lokal offline-first:** Dijalankan melalui Capacitor `BridgeActivity` (`https://localhost`), mendukung IndexedDB dan CORS `POST text/plain` langsung ke Google Apps Script.
- **Android 15 Edge-to-Edge & Safe-Area:** `MainActivity` menerapkan `WindowCompat.setDecorFitsSystemWindows(window, true)` + `ViewCompat.setOnApplyWindowInsetsListener` untuk system bars & display cutout, dipadukan dengan `viewport-fit=cover` dan `env(safe-area-inset-*)`.
- **Runtime Camera Permission + File Chooser:** Izin `CAMERA` diminta secara runtime (`ActivityResultContracts.RequestPermission`) sebelum membuka kamera foto sketch (`onShowFileChooser` + `FileProvider`) maupun pemindai QR ZXing (`Android.scanQr`), dengan fallback otomatis ke galeri bila kamera ditolak.
- **Hardware Back Navigation:** `OnBackPressedCallback` memanggil `window.handleHardwareBack()` agar tombol Back fisik / gesture kembali menutup modal aktif atau kembali ke Dashboard sebelum keluar dari aplikasi.
- **Penyimpanan Sketch Lokal & Share QR:** Foto sketch disimpan di `files/sketches/` (`Android.saveSketchFile` / `readSketchFile` / `deleteSketchFiles`), dan `Android.shareQRText` membuka menu berbagi Android (WhatsApp, dll.).
- **Print Native (`Android.printHtml`) & Memory Cleanup:** Merender dokumen cetak bersih (QR PNG `<img>`) pada WebView khusus dengan `cleanupPrintWebView()` otomatis dan `PrintAttributes` eksplisit untuk **A4**, **Thermal 58 mm**, serta **Thermal 80 mm**.
- **Adaptive Icon, ProGuard, & Gradle Wrapper 8.11.1:** Dilengkapi ikon vektor adaptif Blue Navy (`@mipmap/ic_launcher`), `proguard-rules.pro` untuk menjaga `@JavascriptInterface`, serta wrapper `./gradlew` / `gradlew.bat` (Gradle `8.11.1`, kompatibel dengan AGP `8.7.2` dan `RepositoriesMode.PREFER_PROJECT`).

## Langkah Build APK

1. *(Opsional)* Isi URL Web App Apps Script di `public/config.js` sebelum sync. Anda juga bisa mengaturnya nanti langsung di dalam aplikasi lewat **⚙️ Pengaturan Server**.
2. Jalankan di root project:
   ```sh
   npm install
   npm run cap:sync
   ```
   Perintah ini menyalin seluruh folder `public/` (`index.html`, `styles.css`, `config.js`, `db.js`, `sync.js`, `vendor/qrcode.js`, `app.js`) ke `android/app/src/main/assets/public/` dan menautkan `capacitor.settings.gradle` / `capacitor.build.gradle`.
3. Buka folder `android/` di **Android Studio** (atau bangun via CLI di dalam `android/` menggunakan `./gradlew assembleDebug` / `gradlew.bat assembleDebug` setelah Android SDK terpasang).
4. Pilih **Build → Generate Signed Bundle / APK → APK** (gunakan keystore milik Anda sendiri).
5. Instal APK pada HP. Login sekali saat online untuk mengaktifkan token perangkat 30 hari; setelah itu aplikasi bisa dipakai penuh saat offline dan sync otomatis saat kembali online.

Jangan commit keystore, password keystore, atau URL/kredensial privat ke repositori publik.
