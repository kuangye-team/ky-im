import com.android.build.api.artifact.SingleArtifact
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    ndkVersion = "30.0.16248370"
    compileSdk = 37
    namespace = "team.kuangye.im"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "team.kuangye.im"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        System.getenv("KY_IM_ANDROID_SIGNING_FILE")?.let { path ->
            create("release") {
                storeFile = file(path)
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                storePassword = keyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

androidComponents.onVariants { variant ->
    val name = variant.name.replaceFirstChar { it.uppercase() }
    val version = variant.outputs.single().versionName.get()
    val arch = when (variant.flavorName) {
        "arm" -> "armeabi-v7a"
        else -> variant.flavorName
    }
    val debug = if (variant.buildType == "debug") "-debug" else ""
    val exportApk = tasks.register<Copy>("export${name}Apk") {
        from(variant.artifacts.get(SingleArtifact.APK)) { include("*.apk") }
        into(rootProject.file("../../android-dist"))
        rename { file ->
            val unsigned = if (file.endsWith("-unsigned.apk")) "-unsigned" else ""
            "ky-im-${version}-android-${arch}${debug}${unsigned}.apk"
        }
    }
    tasks.matching { it.name == "assemble$name" }.configureEach { dependsOn(exportApk) }
}

rust {
    rootDirRel = "../../../"
}

// The verifier calls its matching JVM component through JNI.
val cargoLock = providers.fileContents(layout.projectDirectory.file("../../../Cargo.lock")).asText.get()
val verifierVersion = Regex("""name = "rustls-platform-verifier-android"\s+version = "([^"]+)"""")
    .find(cargoLock)?.groupValues?.get(1) ?: error("Missing Android verifier in Cargo.lock")

dependencies {
    // Tauri's ObjectMapper runs at Activity startup. Jackson 2.14–2.19 require API 26.
    implementation(enforcedPlatform("com.fasterxml.jackson:jackson-bom:2.13.5"))
    implementation("org.rustls:rustls-platform-verifier:$verifierVersion")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
