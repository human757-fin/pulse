#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                use tauri::Manager;
                use windows::core::Interface;
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(|webview| unsafe {
                        let configure = || -> windows::core::Result<()> {
                            let settings = webview.controller().CoreWebView2()?.Settings()?;
                            settings.SetIsStatusBarEnabled(false)?;
                            let autofill: ICoreWebView2Settings4 = settings.cast()?;
                            autofill.SetIsGeneralAutofillEnabled(false)?;
                            autofill.SetIsPasswordAutosaveEnabled(false)?;
                            Ok(())
                        };
                        if let Err(error) = configure() { eprintln!("Could not configure browser UI: {error}"); }
                    })?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pulse");
}
