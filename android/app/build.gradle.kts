import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing reads android/keystore/release.properties (ignored by git).
// A release build without it fails instead of producing an unsigned or debug-signed APK.
val releaseProps = Properties().apply {
    rootProject.file("keystore/release.properties").takeIf { it.exists() }?.reader()?.use { load(it) }
}
val wantsRelease = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }
if (wantsRelease && releaseProps.isEmpty) {
    throw GradleException("Missing android/keystore/release.properties; see android/README.md")
}

android {
    namespace = "com.mandarintracking.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.mandarintracking.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (!releaseProps.isEmpty) {
            create("release") {
                storeFile = rootProject.file(releaseProps.getProperty("storeFile"))
                storePassword = releaseProps.getProperty("storePassword")
                keyAlias = releaseProps.getProperty("keyAlias")
                keyPassword = releaseProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (!releaseProps.isEmpty) signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.work:work-runtime:2.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.work:work-testing:2.12.0")
}
