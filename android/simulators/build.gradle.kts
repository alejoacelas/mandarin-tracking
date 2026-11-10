// Stand-ins for the real apps, installed under their real package ids, for emulator tests only.
plugins {
    id("com.android.application")
}

android {
    namespace = "com.mandarintracking.simulators"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "sim"
    }

    flavorDimensions += "app"
    productFlavors {
        create("pleco") { dimension = "app"; applicationId = "com.pleco.chinesesystem"; resValue("string", "app_name", "Pleco (sim)") }
        create("chatgpt") { dimension = "app"; applicationId = "com.openai.chatgpt"; resValue("string", "app_name", "ChatGPT (sim)") }
        create("reader") { dimension = "app"; applicationId = "com.readermobile"; resValue("string", "app_name", "Reader (sim)") }
        create("youtube") { dimension = "app"; applicationId = "com.google.android.youtube"; resValue("string", "app_name", "YouTube (sim)") }
        create("hubbeacon") { dimension = "app"; applicationId = "com.mandarintracking.hubbeacon"; resValue("string", "app_name", "Hub beacon (sim)") }
    }
    buildFeatures { resValues = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
