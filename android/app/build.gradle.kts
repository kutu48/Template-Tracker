plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pancaprima.cnctracker"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.pancaprima.cnctracker"
        minSdk = 24
        targetSdk = 35
        versionCode = 51
        versionName = "5.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    kotlinOptions {
        jvmTarget = "21"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(project(":capacitor-android"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
