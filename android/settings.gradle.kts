pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    // Capacitor (:capacitor-android) mendeklarasikan repositories { google(); mavenCentral() } sendiri
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "CNCTracker"
include(":app")
include(":capacitor-android")
project(":capacitor-android").projectDir = file("../node_modules/@capacitor/android/capacitor")
