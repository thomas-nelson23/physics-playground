mod midi;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(midi::MidiState::default())
        .invoke_handler(tauri::generate_handler![
            midi::midi_inputs,
            midi::midi_connect,
            midi::midi_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tonefield");
}
