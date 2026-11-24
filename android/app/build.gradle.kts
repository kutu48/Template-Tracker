plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val appUrl = providers.gradleProperty("APP_URL").getOrElse("https://example.com")
android {
    namespace = "com.pancaprima.cnctracker"
    compileSdk = 35
    defaultConfig { applicationId = "com.pancaprima.cnctracker"; minSdk = 24; targetSdk = 35; versionCode = 40; versionName = "4.0.0"; buildConfigField("String", "APP_URL", "\"$appUrl\"") }
    buildFeatures { buildConfig = true }
}
dependencies { implementation("androidx.appcompat:appcompat:1.7.0"); implementation("com.journeyapps:zxing-android-embedded:4.3.0") }
