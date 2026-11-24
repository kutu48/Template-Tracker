# CNC Template Tracker — Android Studio

APK ini adalah WebView wrapper dari versi web yang di-host. Cetak memakai Android Print Framework; pilihan printer berasal dari layanan cetak yang terpasang/terdeteksi Android.

1. Deploy folder `public/` ke hosting HTTPS yang dapat diakses HP.
2. Edit `APP_URL` di `android/gradle.properties` menjadi URL `index.html` hasil deploy.
3. Buka folder `android/` di Android Studio dan lakukan Gradle Sync.
4. Untuk APK: **Build → Generate Signed Bundle / APK → APK**; buat/pilih keystore sendiri.
5. Instal APK pada HP. Pemindaian QR memakai ZXing; cetak dapat diarahkan ke printer yang muncul di Android Print Service atau disimpan sebagai PDF.

Printer termal hanya muncul bila Android memiliki Print Service/driver yang kompatibel. Cetak dari browser PC menggunakan dialog print browser, termasuk opsi **Save as PDF**.

Jangan commit keystore, password keystore, atau URL/kredensial privat ke repositori publik.
