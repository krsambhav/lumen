//! Paired AirPlay 2 video sessions on Apple TV. The sender owns the socket
//! and reports receiver playback events over a private pipe.
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::{CastTarget, EventSink, Loadable, RemoteState, TargetEvent};
use crate::media::tools::{command, Tool};

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum Message {
    Pairing,
    Connecting,
    Active,
    State {
        state: String,
        position: Option<f64>,
    },
    Finished,
    Failed {
        reason: String,
    },
}

pub struct AppleTv(Mutex<Option<mpsc::UnboundedSender<Value>>>);

impl AppleTv {
    pub fn open(address: std::net::IpAddr, id: &str, events: EventSink) -> Arc<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        let id = id.trim_start_matches("airplay:").to_owned();
        tauri::async_runtime::spawn(async move {
            if let Err(reason) = run(address, &id, rx, &events).await {
                events(TargetEvent::Failed(reason));
            }
        });
        Arc::new(Self(Mutex::new(Some(tx))))
    }

    fn send(&self, value: Value) {
        if let Some(tx) = &*self.0.lock() {
            let _ = tx.send(value);
        }
    }
}

async fn run(
    address: std::net::IpAddr,
    id: &str,
    mut rx: mpsc::UnboundedReceiver<Value>,
    events: &EventSink,
) -> Result<(), String> {
    let command = command(Tool::AirPlay).ok_or("The AirPlay sender is missing.")?;
    let mut child = tokio::process::Command::from(command)
        .args([&address.to_string(), id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut input = child.stdin.take().ok_or("AirPlay input is unavailable")?;
    let mut lines =
        BufReader::new(child.stdout.take().ok_or("AirPlay output is unavailable")?).lines();
    loop {
        tokio::select! {
            next = rx.recv() => {
                let Some(command) = next else { break };
                let mut data = command.to_string();
                data.push('\n');
                input.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
            }
            line = lines.next_line() => {
                let line = line.map_err(|e| e.to_string())?.ok_or("The AirPlay sender disconnected.")?;
                let event = match serde_json::from_str::<Message>(&line).map_err(|e| e.to_string())? {
                    Message::Pairing => TargetEvent::Pairing(true),
                    Message::Connecting => TargetEvent::Pairing(false),
                    Message::Active => TargetEvent::Active(None),
                    Message::State {state, position} => TargetEvent::State {
                        state: match state.as_str() {
                            "paused" => RemoteState::Paused,
                            "playing" => RemoteState::Playing,
                            _ => RemoteState::Buffering,
                        },
                        at: position,
                    },
                    Message::Finished => TargetEvent::Finished,
                    Message::Failed {reason} => return Err(reason),
                };
                events(event);
            }
        }
    }
    drop(input);
    if tokio::time::timeout(Duration::from_secs(4), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    Ok(())
}

impl CastTarget for AppleTv {
    fn seeks_with_new_stream(&self) -> bool {
        true
    }
    fn load(&self, media: Loadable) {
        self.send(json!({"cmd":"load","url":media.url,"start":media.start,"play":media.autoplay}));
    }
    fn play(&self) {
        self.send(json!({"cmd":"play"}));
    }
    fn pause(&self) {
        self.send(json!({"cmd":"pause"}));
    }
    fn seek(&self, at: f64) {
        self.send(json!({"cmd":"seek","at":at}));
    }
    fn set_volume(&self, level: f64) {
        self.send(json!({"cmd":"volume","level":level}));
    }
    fn set_muted(&self, muted: bool) {
        self.send(json!({"cmd":"mute","muted":muted}));
    }
    fn set_subtitle(&self, _: Option<i32>) -> bool {
        false
    }
    fn pair(&self, pin: &str) {
        self.send(json!({"cmd":"pin","pin":pin}));
    }
    fn stop(&self) {
        self.0.lock().take();
    }
}
