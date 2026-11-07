mod commands;
mod error;
mod secrets;
mod state;
mod store;

use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("cache.sqlite3"))?;
            app.manage(AppState::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::connect,
            commands::list_projects,
            commands::select_project,
            commands::get_tree,
            commands::get_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
