//! Tauri commands: thin, typed entry points, one file per domain.
//!
//! A command validates its input, calls into the module that owns the work,
//! and returns `AppResult`. Nothing in here contains logic worth testing on
//! its own; the modules it calls are tested directly.

pub mod app;
pub mod cast;
pub mod files;
pub mod history;
pub mod player;
pub mod playlist;
pub mod session;
pub mod settings;
pub mod sync;
pub mod torrents;
pub mod window;
