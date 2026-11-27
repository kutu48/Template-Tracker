# Aturan ProGuard / R8 untuk CNC Template Tracker (Capacitor + AndroidBridge)

# Pertahankan semua method @JavascriptInterface pada AndroidBridge agar bisa dipanggil dari WebView JS
-keepattributes JavascriptInterface
-keepclassmembers class com.pancaprima.cnctracker.MainActivity$AndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Pertahankan Capacitor Bridge & Plugin
-keep class com.getcapacitor.** { *; }

# ZXing Barcode Scanner
-dontwarn com.google.zxing.**
