//! The playback engine: libmpv behind a safe Rust API.
//!
//! - `ffi`     raw bindings
//! - `mpv`     one safe player handle: options, commands, properties, events
//! - `render`  the render API: mpv draws frames into the host's framebuffer
//! - `player`  the player: event loop, state snapshot, typed changes
//! - `types`   what the player reports to the interface

pub mod adjust;
pub mod failure;
mod ffi;
pub mod mpv;
pub mod player;
pub mod render;
pub mod types;

#[cfg(test)]
pub mod test_support;
