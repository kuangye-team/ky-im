use tauri::{
    Manager,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

pub fn plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("nearby")
        .setup(|app, api| {
            let handle: PluginHandle<_> =
                api.register_android_plugin("team.kuangye.im", "NearbyPlugin")?;
            app.manage(handle);
            Ok(())
        })
        .build()
}

pub fn initialize() -> Result<(), jni::errors::Error> {
    let context = ndk_context::android_context();
    // Tao installs the VM and a global Activity reference before entering Rust.
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) };
    vm.with_local_frame(8, |env| {
        let activity = unsafe { jni::objects::JObject::from_raw(env, context.context().cast()) };
        let application = env
            .call_method(
                &activity,
                jni::jni_str!("getApplicationContext"),
                jni::jni_sig!(() -> android.content.Context),
                &[],
            )?
            .l()?;
        rustls_platform_verifier::android::init_with_env(env, application)
    })
}

#[tauri::command]
pub async fn request_nearby(app: tauri::AppHandle, mode: String) -> Result<bool, String> {
    let result: serde_json::Value = app
        .state::<PluginHandle<tauri::Wry>>()
        .run_mobile_plugin_async("requestAccess", serde_json::json!({ "mode": mode }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(result["granted"].as_bool() == Some(true))
}

pub async fn network_session(
    app: &tauri::AppHandle,
    session: &str,
    enabled: bool,
) -> Result<(), String> {
    app.state::<PluginHandle<tauri::Wry>>()
        .run_mobile_plugin_async(
            "network",
            serde_json::json!({ "session":session, "enabled": enabled }),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn android_background(
    app: tauri::AppHandle,
    enabled: Option<bool>,
) -> Result<bool, String> {
    let value: serde_json::Value = app
        .state::<PluginHandle<tauri::Wry>>()
        .run_mobile_plugin_async("background", serde_json::json!({ "enabled": enabled }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(value["enabled"].as_bool() == Some(true))
}

pub fn peer_event(app: &tauri::AppHandle, session: &str, event: &serde_json::Value) {
    if let Some(kind @ ("connected" | "connection_closed")) = event["type"].as_str() {
        let _ = app.state::<PluginHandle<tauri::Wry>>().run_mobile_plugin::<()>("peer", serde_json::json!({
            "session":session, "connection":event["connectionId"], "connected":kind == "connected"
        }));
    }
}
