// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `agent-studio db connect …` from one of the app's terminals: a client of the running app,
    // never a second window (agent_ctl::cli).
    if let Some(code) = agent_studio_scaffold_lib::agent_ctl::cli::run_if_cli() {
        std::process::exit(code);
    }
    agent_studio_scaffold_lib::run()
}
