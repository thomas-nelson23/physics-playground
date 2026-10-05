//! MIDI input. The Linux (WebKitGTK) and macOS (WKWebView) webviews don't
//! implement Web MIDI, so ports are opened here with midir and every message
//! is forwarded to the frontend as a `midi-message` event.

use std::collections::HashMap;
use std::sync::Mutex;

use midir::{Ignore, MidiInput, MidiInputConnection};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct MidiState {
    connections: Mutex<HashMap<String, MidiInputConnection<()>>>,
}

#[derive(Clone, serde::Serialize)]
struct MidiMessage {
    port: String,
    data: Vec<u8>,
}

fn new_input(name: &str) -> Result<MidiInput, String> {
    MidiInput::new(name).map_err(|e| format!("MIDI is unavailable: {e}"))
}

/// Names of the MIDI inputs currently plugged in.
#[tauri::command]
pub fn midi_inputs() -> Result<Vec<String>, String> {
    let input = new_input("Physics Playground (scan)")?;
    Ok(input
        .ports()
        .iter()
        .filter_map(|p| input.port_name(p).ok())
        .collect())
}

/// Start listening to the input called `name`. Connecting twice is a no-op.
#[tauri::command]
pub fn midi_connect(app: AppHandle, state: State<MidiState>, name: String) -> Result<(), String> {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    if connections.contains_key(&name) {
        return Ok(());
    }
    let mut input = new_input("Physics Playground")?;
    // Clock and active-sensing bytes arrive dozens of times a second and the
    // app doesn't use them, so don't forward them across the IPC bridge.
    input.ignore(Ignore::SysexAndTime);
    let port = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).ok().as_deref() == Some(name.as_str()))
        .ok_or_else(|| format!("MIDI input \"{name}\" is not connected"))?;
    let port_name = name.clone();
    let connection = input
        .connect(
            &port,
            "physics-playground-in",
            move |_stamp, data, _| {
                let _ = app.emit(
                    "midi-message",
                    MidiMessage {
                        port: port_name.clone(),
                        data: data.to_vec(),
                    },
                );
            },
            (),
        )
        .map_err(|e| format!("Could not open \"{name}\": {e}"))?;
    connections.insert(name, connection);
    Ok(())
}

#[tauri::command]
pub fn midi_disconnect(state: State<MidiState>, name: String) -> Result<(), String> {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    if let Some(connection) = connections.remove(&name) {
        connection.close();
    }
    Ok(())
}
