mod assets;
mod commands;
mod error;
mod navigation;
mod secrets;
mod state;
mod store;
mod sync;

use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation::guard(context.config()))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("cache.sqlite3"))?;
            app.manage(AppState::new(store));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(assets::SCHEME, assets::handle)
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::connect,
            commands::list_projects,
            commands::select_project,
            commands::get_tree,
            commands::get_document,
            commands::save_local,
            commands::discard_local,
            commands::create_document,
            commands::recent_documents,
            commands::publish_document,
            commands::resolve_conflict,
        ])
        .run(context)
        .expect("error while running tauri application");
}
