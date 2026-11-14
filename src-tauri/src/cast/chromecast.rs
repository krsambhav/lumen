//! Google Cast: the CASTV2 protocol, spoken to a Chromecast or Google TV.
//!
//! A sender opens TLS to port 8009 and exchanges length-prefixed protobuf
//! `CastMessage`s, each carrying JSON in a namespace. Lumen launches the
//! Default Media Receiver (app `CC1AD845`), which plays any address it is
//! given and takes subtitles as WebVTT tracks. Everything here runs in one
//! task per device; the handle sends it commands.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value as Json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls;

use super::{CastTarget, EventSink, Loadable, RemoteState, TargetEvent};
use crate::error::{AppError, AppResult};

/// The Default Media Receiver.
const MEDIA_RECEIVER: &str = "CC1AD845";
const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";
const SENDER: &str = "sender-lumen";
const PLATFORM: &str = "receiver-0";

/// One message of the protocol. Only text payloads are used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CastMessage {
    pub source: String,
    pub destination: String,
    pub namespace: String,
    pub payload: String,
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn text_field(out: &mut Vec<u8>, field: u8, text: &str) {
    out.push((field << 3) | 2);
    varint(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

impl CastMessage {
    /// The message as protobuf, without its length prefix.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.payload.len() + 96);
        // protocol_version = CASTV2_1_0 (0)
        out.extend_from_slice(&[0x08, 0x00]);
        text_field(&mut out, 2, &self.source);
        text_field(&mut out, 3, &self.destination);
        text_field(&mut out, 4, &self.namespace);
        // payload_type = STRING (0)
        out.extend_from_slice(&[0x28, 0x00]);
        text_field(&mut out, 6, &self.payload);
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let mut message = Self {
            source: String::new(),
            destination: String::new(),
            namespace: String::new(),
            payload: String::new(),
        };
        let mut at = 0usize;
        let read_varint = |at: &mut usize| -> Option<u64> {
            let mut value = 0u64;
            for shift in (0..64).step_by(7) {
                let byte = *bytes.get(*at)?;
                *at += 1;
                value |= u64::from(byte & 0x7f) << shift;
                if byte & 0x80 == 0 {
                    return Some(value);
                }
            }
            None
        };
        while at < bytes.len() {
            let key = read_varint(&mut at)?;
            let (field, wire) = (key >> 3, key & 7);
            match wire {
                0 => {
                    read_varint(&mut at)?;
                }
                2 => {
                    let len = usize::try_from(read_varint(&mut at)?).ok()?;
                    let data = bytes.get(at..at.checked_add(len)?)?;
                    at += len;
                    let text = String::from_utf8_lossy(data).into_owned();
                    match field {
                        2 => message.source = text,
                        3 => message.destination = text,
                        4 => message.namespace = text,
                        6 => message.payload = text,
                        _ => {}
                    }
                }
                5 => at += 4,
                1 => at += 8,
                _ => return None,
            }
        }
        Some(message)
    }
}

/// Cast devices present certificates of their own making; whether a device
/// is a real Chromecast is not Lumen's question, only whether it plays.
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls_config() -> AppResult<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| AppError::Internal(format!("TLS: {error}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
        .with_no_client_auth();
    Ok(config)
}

enum Command {
    Load(Box<Loadable>),
    Play,
    Pause,
    Seek(f64),
    Volume(f64),
    Muted(bool),
    Subtitle(Option<i32>),
    Stop,
}

/// A device being cast to. Dropping it does not end the session: `stop` does.
pub struct Chromecast {
    commands: mpsc::UnboundedSender<Command>,
}

impl CastTarget for Chromecast {
    fn load(&self, media: Loadable) {
        let _ = self.commands.send(Command::Load(Box::new(media)));
    }
    fn play(&self) {
        let _ = self.commands.send(Command::Play);
    }
    fn pause(&self) {
        let _ = self.commands.send(Command::Pause);
    }
    fn seek(&self, seconds: f64) {
        let _ = self.commands.send(Command::Seek(seconds));
    }
    fn set_volume(&self, level: f64) {
        let _ = self.commands.send(Command::Volume(level));
    }
    fn set_muted(&self, muted: bool) {
        let _ = self.commands.send(Command::Muted(muted));
    }
    fn set_subtitle(&self, id: Option<i32>) -> bool {
        let _ = self.commands.send(Command::Subtitle(id));
        true
    }
    fn stop(&self) {
        let _ = self.commands.send(Command::Stop);
    }
}

/// Connects to the device at `address` and launches the media receiver on
/// it. Returns the handle and this Mac's address as the device sees it.
pub async fn connect(address: SocketAddr, events: EventSink) -> AppResult<(Chromecast, IpAddr)> {
    let tcp = tokio::time::timeout(Duration::from_secs(6), TcpStream::connect(address))
        .await
        .map_err(|_| AppError::Invalid("the device did not answer".to_owned()))?
        .map_err(|error| AppError::Invalid(format!("the device could not be reached: {error}")))?;
    let _ = tcp.set_nodelay(true);
    let local = tcp
        .local_addr()
        .map_err(|error| AppError::Internal(error.to_string()))?
        .ip();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config()?));
    let name = rustls::pki_types::ServerName::IpAddress(address.ip().into());
    let tls = tokio::time::timeout(Duration::from_secs(6), connector.connect(name, tcp))
        .await
        .map_err(|_| AppError::Invalid("the device did not answer".to_owned()))?
        .map_err(|error| {
            AppError::Invalid(format!("the device refused the connection: {error}"))
        })?;
    let (reader, writer) = tokio::io::split(tls);
    let (incoming_tx, incoming) = mpsc::unbounded_channel();
    tokio::spawn(read_loop(reader, incoming_tx));
    let (commands_tx, commands) = mpsc::unbounded_channel();
    let session = Session {
        writer,
        events,
        next_request: 1,
        transport: None,
        app_session: None,
        media_session: None,
        launched: false,
        pending: None,
        playing: false,
        stopping: false,
        last_heard: tokio::time::Instant::now(),
    };
    tokio::spawn(session.run(incoming, commands));
    Ok((
        Chromecast {
            commands: commands_tx,
        },
        local,
    ))
}

async fn read_loop(
    mut reader: ReadHalf<TlsStream<TcpStream>>,
    out: mpsc::UnboundedSender<CastMessage>,
) {
    loop {
        let mut len = [0u8; 4];
        if reader.read_exact(&mut len).await.is_err() {
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > 1 << 20 {
            return;
        }
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }
        if let Some(message) = CastMessage::decode(&body) {
            if out.send(message).is_err() {
                return;
            }
        }
    }
}

struct Session {
    writer: WriteHalf<TlsStream<TcpStream>>,
    events: EventSink,
    next_request: u64,
    /// The receiver app's address for messages, once it has launched.
    transport: Option<String>,
    app_session: Option<String>,
    media_session: Option<i64>,
    launched: bool,
    /// A film to load as soon as the receiver is up.
    pending: Option<Box<Loadable>>,
    playing: bool,
    stopping: bool,
    last_heard: tokio::time::Instant,
}

impl Session {
    async fn send(
        &mut self,
        destination: &str,
        namespace: &str,
        payload: Json,
    ) -> std::io::Result<()> {
        let message = CastMessage {
            source: SENDER.to_owned(),
            destination: destination.to_owned(),
            namespace: namespace.to_owned(),
            payload: payload.to_string(),
        };
        let body = message.encode();
        let mut frame = Vec::with_capacity(body.len() + 4);
        frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
        frame.extend_from_slice(&body);
        self.writer.write_all(&frame).await?;
        self.writer.flush().await
    }

    fn request(&mut self) -> u64 {
        self.next_request += 1;
        self.next_request
    }

    async fn send_media(&mut self, mut payload: Json) -> std::io::Result<()> {
        let (Some(transport), Some(media)) = (self.transport.clone(), self.media_session) else {
            return Ok(());
        };
        payload["requestId"] = json!(self.request());
        payload["mediaSessionId"] = json!(media);
        self.send(&transport, NS_MEDIA, payload).await
    }

    async fn run(
        mut self,
        mut incoming: mpsc::UnboundedReceiver<CastMessage>,
        mut commands: mpsc::UnboundedReceiver<Command>,
    ) {
        let started = async {
            self.send(PLATFORM, NS_CONNECTION, json!({"type": "CONNECT"}))
                .await?;
            let id = self.request();
            self.send(
                PLATFORM,
                NS_RECEIVER,
                json!({"type": "LAUNCH", "appId": MEDIA_RECEIVER, "requestId": id}),
            )
            .await
        }
        .await;
        if let Err(error) = started {
            (self.events)(TargetEvent::Closed(Some(format!(
                "the device stopped answering: {error}"
            ))));
            return;
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
        let mut poll = tokio::time::interval(Duration::from_secs(1));
        let launch_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let result = tokio::select! {
                message = incoming.recv() => match message {
                    Some(message) => {
                        self.last_heard = tokio::time::Instant::now();
                        self.heard(message).await
                    }
                    None => {
                        if !self.stopping {
                            (self.events)(TargetEvent::Closed(Some("the connection to the device was lost".to_owned())));
                        }
                        return;
                    }
                },
                command = commands.recv() => match command {
                    Some(Command::Stop) | None => {
                        self.stopping = true;
                        let _ = self.finish().await;
                        (self.events)(TargetEvent::Closed(None));
                        return;
                    }
                    Some(command) => self.command(command).await,
                },
                _ = heartbeat.tick() => {
                    if self.last_heard.elapsed() > Duration::from_secs(16) {
                        (self.events)(TargetEvent::Closed(Some("the device stopped answering".to_owned())));
                        return;
                    }
                    if !self.launched && tokio::time::Instant::now() > launch_deadline {
                        (self.events)(TargetEvent::Closed(Some("the device would not start the player".to_owned())));
                        return;
                    }
                    self.send(PLATFORM, NS_HEARTBEAT, json!({"type": "PING"})).await
                },
                _ = poll.tick() => {
                    if self.playing {
                        self.send_media(json!({"type": "GET_STATUS"})).await
                    } else {
                        Ok(())
                    }
                },
            };
            if let Err(error) = result {
                (self.events)(TargetEvent::Closed(Some(format!(
                    "the device stopped answering: {error}"
                ))));
                return;
            }
        }
    }

    async fn finish(&mut self) -> std::io::Result<()> {
        if let Some(app) = self.app_session.clone() {
            let id = self.request();
            self.send(
                PLATFORM,
                NS_RECEIVER,
                json!({"type": "STOP", "sessionId": app, "requestId": id}),
            )
            .await?;
        }
        if let Some(transport) = self.transport.clone() {
            self.send(&transport, NS_CONNECTION, json!({"type": "CLOSE"}))
                .await?;
        }
        self.send(PLATFORM, NS_CONNECTION, json!({"type": "CLOSE"}))
            .await
    }

    async fn command(&mut self, command: Command) -> std::io::Result<()> {
        match command {
            Command::Load(media) => {
                if self.transport.is_some() {
                    self.load(&media).await
                } else {
                    self.pending = Some(media);
                    Ok(())
                }
            }
            Command::Play => self.send_media(json!({"type": "PLAY"})).await,
            Command::Pause => self.send_media(json!({"type": "PAUSE"})).await,
            Command::Seek(seconds) => {
                self.send_media(json!({"type": "SEEK", "currentTime": seconds.max(0.0), "resumeState": "PLAYBACK_START"}))
                    .await
            }
            Command::Volume(level) => {
                let id = self.request();
                self.send(
                    PLATFORM,
                    NS_RECEIVER,
                    json!({"type": "SET_VOLUME", "volume": {"level": level.clamp(0.0, 1.0)}, "requestId": id}),
                )
                .await
            }
            Command::Muted(muted) => {
                let id = self.request();
                self.send(
                    PLATFORM,
                    NS_RECEIVER,
                    json!({"type": "SET_VOLUME", "volume": {"muted": muted}, "requestId": id}),
                )
                .await
            }
            Command::Subtitle(id) => {
                let active: Vec<i32> = id.into_iter().collect();
                self.send_media(json!({"type": "EDIT_TRACKS_INFO", "activeTrackIds": active}))
                    .await
            }
            Command::Stop => Ok(()),
        }
    }

    async fn load(&mut self, media: &Loadable) -> std::io::Result<()> {
        let Some(transport) = self.transport.clone() else {
            return Ok(());
        };
        self.media_session = None;
        let id = self.request();
        let payload = load_payload(media, self.app_session.as_deref(), id);
        self.send(&transport, NS_MEDIA, payload).await
    }

    async fn heard(&mut self, message: CastMessage) -> std::io::Result<()> {
        let Ok(payload) = serde_json::from_str::<Json>(&message.payload) else {
            return Ok(());
        };
        let kind = payload
            .get("type")
            .and_then(Json::as_str)
            .unwrap_or_default();
        match (message.namespace.as_str(), kind) {
            (NS_HEARTBEAT, "PING") => {
                return self
                    .send(&message.source, NS_HEARTBEAT, json!({"type": "PONG"}))
                    .await;
            }
            (NS_CONNECTION, "CLOSE") if Some(&message.source) == self.transport.as_ref() => {
                if !self.stopping {
                    (self.events)(TargetEvent::Closed(Some(
                        "the device closed the player".to_owned(),
                    )));
                }
                self.transport = None;
            }
            (NS_RECEIVER, "RECEIVER_STATUS") => {
                if let Some(volume) = payload.pointer("/status/volume") {
                    let level = volume.get("level").and_then(Json::as_f64);
                    let muted = volume.get("muted").and_then(Json::as_bool);
                    if let (Some(level), Some(muted)) = (level, muted) {
                        (self.events)(TargetEvent::Volume { level, muted });
                    }
                }
                let app = payload
                    .pointer("/status/applications")
                    .and_then(Json::as_array)
                    .and_then(|apps| {
                        apps.iter().find(|app| {
                            app.get("appId").and_then(Json::as_str) == Some(MEDIA_RECEIVER)
                        })
                    })
                    .cloned();
                match app {
                    Some(app) => {
                        let transport = app
                            .get("transportId")
                            .and_then(Json::as_str)
                            .map(str::to_owned);
                        if self.transport.is_none() {
                            if let Some(transport) = transport {
                                self.transport = Some(transport.clone());
                                self.app_session = app
                                    .get("sessionId")
                                    .and_then(Json::as_str)
                                    .map(str::to_owned);
                                self.launched = true;
                                self.send(&transport, NS_CONNECTION, json!({"type": "CONNECT"}))
                                    .await?;
                                (self.events)(TargetEvent::Active(None));
                                if let Some(media) = self.pending.take() {
                                    self.load(&media).await?;
                                }
                            }
                        }
                    }
                    None if self.launched && !self.stopping => {
                        // Someone else took the TV: another app was started on it.
                        (self.events)(TargetEvent::Closed(Some(
                            "the device started something else".to_owned(),
                        )));
                        self.launched = false;
                        self.transport = None;
                    }
                    None => {}
                }
            }
            (NS_RECEIVER, "LAUNCH_ERROR") => {
                (self.events)(TargetEvent::Closed(Some(
                    "the device would not start the player".to_owned(),
                )));
            }
            (NS_MEDIA, "MEDIA_STATUS") => {
                if let Some(status) = payload
                    .get("status")
                    .and_then(Json::as_array)
                    .and_then(|s| s.first())
                {
                    self.media_status(status);
                }
            }
            (NS_MEDIA, "LOAD_FAILED" | "INVALID_REQUEST") => {
                let reason = payload
                    .get("reason")
                    .and_then(Json::as_str)
                    .unwrap_or("it could not be played");
                (self.events)(TargetEvent::Failed(format!(
                    "the device could not play it ({reason})"
                )));
            }
            _ => {}
        }
        Ok(())
    }

    fn media_status(&mut self, status: &Json) {
        if let Some(id) = status.get("mediaSessionId").and_then(Json::as_i64) {
            self.media_session = Some(id);
        }
        let at = status.get("currentTime").and_then(Json::as_f64);
        let state = status
            .get("playerState")
            .and_then(Json::as_str)
            .unwrap_or_default();
        self.playing = state == "PLAYING" || state == "BUFFERING";
        let remote = match state {
            "PLAYING" => RemoteState::Playing,
            "PAUSED" => RemoteState::Paused,
            "BUFFERING" | "LOADING" => RemoteState::Buffering,
            "IDLE" => {
                match status.get("idleReason").and_then(Json::as_str) {
                    Some("FINISHED") => (self.events)(TargetEvent::Finished),
                    Some("ERROR") => (self.events)(TargetEvent::Failed(
                        "the device could not play it".to_owned(),
                    )),
                    _ => {}
                }
                self.media_session = None;
                return;
            }
            _ => return,
        };
        (self.events)(TargetEvent::State { state: remote, at });
    }
}

/// The LOAD request for a film.
pub fn load_payload(media: &Loadable, session: Option<&str>, request: u64) -> Json {
    let tracks: Vec<Json> = media
        .subtitles
        .iter()
        .map(|track| {
            let mut entry = json!({
                "trackId": track.id,
                "type": "TEXT",
                "subtype": "SUBTITLES",
                "trackContentId": track.url,
                "trackContentType": "text/vtt",
                "name": track.name,
            });
            if let Some(language) = &track.language {
                entry["language"] = json!(language);
            }
            entry
        })
        .collect();
    let mut info = json!({
        "contentId": media.url,
        "contentUrl": media.url,
        "contentType": media.content_type,
        "streamType": "BUFFERED",
        "metadata": {"metadataType": 0, "title": media.title},
        "tracks": tracks,
        "textTrackStyle": {
            "backgroundColor": "#00000000",
            "foregroundColor": "#FFFFFFFF",
            "edgeType": "OUTLINE",
            "edgeColor": "#000000FF",
            "fontScale": 1.0,
            "fontFamily": "Helvetica Neue",
            "fontGenericFamily": "SANS_SERIF"
        }
    });
    if let Some(duration) = media.duration {
        info["duration"] = json!(duration);
    }
    let mut payload = json!({
        "type": "LOAD",
        "requestId": request,
        "media": info,
        "autoplay": media.autoplay,
        "currentTime": media.start,
        "activeTrackIds": media.active_subtitle.into_iter().collect::<Vec<i32>>(),
    });
    if let Some(session) = session {
        payload["sessionId"] = json!(session);
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_message_survives_the_wire() {
        let message = CastMessage {
            source: SENDER.to_owned(),
            destination: PLATFORM.to_owned(),
            namespace: NS_RECEIVER.to_owned(),
            payload: json!({"type": "LAUNCH", "appId": MEDIA_RECEIVER, "requestId": 1}).to_string(),
        };
        assert_eq!(CastMessage::decode(&message.encode()), Some(message));
    }

    #[test]
    fn a_long_payload_has_a_long_length() {
        let message = CastMessage {
            source: "a".to_owned(),
            destination: "b".to_owned(),
            namespace: "c".to_owned(),
            payload: "x".repeat(300),
        };
        let bytes = message.encode();
        // 300 is two bytes of varint: 0xac 0x02.
        assert!(bytes.windows(3).any(|w| w == [0x32, 0xac, 0x02]));
        assert_eq!(CastMessage::decode(&bytes).unwrap().payload.len(), 300);
    }

    #[test]
    fn loads_with_its_subtitles_and_start() {
        let media = Loadable {
            url: "http://10.0.0.2:5000/t/stream.mp4".to_owned(),
            content_type: "video/mp4".to_owned(),
            title: "A Quiet Hour".to_owned(),
            duration: Some(780.0),
            start: 0.0,
            autoplay: true,
            subtitles: vec![super::super::SideSubtitle {
                id: 3,
                url: "http://10.0.0.2:5000/t/subs/3.vtt".to_owned(),
                name: "English".to_owned(),
                language: Some("eng".to_owned()),
            }],
            active_subtitle: Some(3),
        };
        let payload = load_payload(&media, Some("abc"), 7);
        assert_eq!(
            payload["media"]["tracks"][0]["trackContentType"],
            "text/vtt"
        );
        assert_eq!(payload["activeTrackIds"], json!([3]));
        assert_eq!(payload["sessionId"], "abc");
        assert_eq!(payload["media"]["duration"], 780.0);
    }

    /// A pretend Chromecast: TLS on a local port, answering the launch, the
    /// load and a pause the way a real receiver does.
    async fn fake_receiver() -> (SocketAddr, tokio::task::JoinHandle<Vec<String>>) {
        let key = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let cert = key.cert.der().clone();
        let private =
            rustls::pki_types::PrivateKeyDer::Pkcs8(key.signing_key.serialize_der().into());
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], private)
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = acceptor.accept(tcp).await.unwrap();
            let mut heard = Vec::new();
            loop {
                let mut len = [0u8; 4];
                if tls.read_exact(&mut len).await.is_err() {
                    return heard;
                }
                let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
                tls.read_exact(&mut body).await.unwrap();
                let message = CastMessage::decode(&body).unwrap();
                let payload: Json = serde_json::from_str(&message.payload).unwrap();
                let kind = payload["type"].as_str().unwrap_or_default().to_owned();
                heard.push(kind.clone());
                let reply = |namespace: &str, source: &str, payload: Json| {
                    let body = CastMessage {
                        source: source.to_owned(),
                        destination: SENDER.to_owned(),
                        namespace: namespace.to_owned(),
                        payload: payload.to_string(),
                    }
                    .encode();
                    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
                    frame.extend(body);
                    frame
                };
                let answer = match kind.as_str() {
                    "LAUNCH" => Some(reply(
                        NS_RECEIVER,
                        PLATFORM,
                        json!({"type": "RECEIVER_STATUS", "status": {
                        "volume": {"level": 0.4, "muted": false},
                        "applications": [{"appId": MEDIA_RECEIVER, "transportId": "web-7", "sessionId": "s-1"}]}}),
                    )),
                    "LOAD" => {
                        assert_eq!(payload["sessionId"], "s-1");
                        assert_eq!(message.destination, "web-7");
                        Some(reply(
                            NS_MEDIA,
                            "web-7",
                            json!({"type": "MEDIA_STATUS", "status": [{
                            "mediaSessionId": 3, "playerState": "PLAYING", "currentTime": 2.5}]}),
                        ))
                    }
                    "PAUSE" => {
                        assert_eq!(payload["mediaSessionId"], 3);
                        Some(reply(
                            NS_MEDIA,
                            "web-7",
                            json!({"type": "MEDIA_STATUS", "status": [{
                            "mediaSessionId": 3, "playerState": "PAUSED", "currentTime": 3.0}]}),
                        ))
                    }
                    "STOP" => Some(reply(
                        NS_MEDIA,
                        "web-7",
                        json!({"type": "MEDIA_STATUS", "status": [{
                            "mediaSessionId": 3, "playerState": "IDLE", "idleReason": "FINISHED"}]}),
                    )),
                    _ => None,
                };
                if let Some(answer) = answer {
                    tls.write_all(&answer).await.unwrap();
                }
            }
        });
        (address, handle)
    }

    #[tokio::test]
    async fn launches_loads_and_controls_a_receiver() {
        let (address, receiver) = fake_receiver().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let (cast, local) = connect(address, sink).await.unwrap();
        assert!(local.is_loopback());
        cast.load(Loadable {
            url: "http://127.0.0.1/x".to_owned(),
            content_type: "video/mp4".to_owned(),
            title: "Film".to_owned(),
            duration: None,
            start: 0.0,
            autoplay: true,
            subtitles: Vec::new(),
            active_subtitle: None,
        });
        async fn next(rx: &mut mpsc::UnboundedReceiver<TargetEvent>) -> TargetEvent {
            tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap()
        }
        assert_eq!(
            next(&mut rx).await,
            TargetEvent::Volume {
                level: 0.4,
                muted: false
            }
        );
        assert_eq!(next(&mut rx).await, TargetEvent::Active(None));
        assert_eq!(
            next(&mut rx).await,
            TargetEvent::State {
                state: RemoteState::Playing,
                at: Some(2.5)
            }
        );
        cast.pause();
        assert_eq!(
            next(&mut rx).await,
            TargetEvent::State {
                state: RemoteState::Paused,
                at: Some(3.0)
            }
        );
        cast.stop();
        assert_eq!(next(&mut rx).await, TargetEvent::Closed(None));
        let mut heard = tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .unwrap()
            .unwrap();
        heard.retain(|kind| kind != "PING");
        assert_eq!(heard[..4], ["CONNECT", "LAUNCH", "CONNECT", "LOAD"]);
        assert!(heard.contains(&"PAUSE".to_owned()));
        assert!(heard.ends_with(&["STOP".to_owned(), "CLOSE".to_owned(), "CLOSE".to_owned()]));
    }
}
