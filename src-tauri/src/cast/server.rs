//! The small web server a cast device fetches the film from.
//!
//! A TV cannot read the Mac's disk, so whatever is cast is published here
//! under an unguessable token, on the address of the network the device is
//! on, for as long as it is being cast. It speaks just enough HTTP/1.1 for
//! media players: GET and HEAD, byte ranges on files, a stream that is made
//! as it is read, a folder of HTTP Live Streaming segments, and WebVTT with
//! the CORS headers a Chromecast insists on.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::media::{self, SubtitleSource};
use crate::media::tools::{self, Tool};

/// Makes the FFmpeg command for a stream, each time a device asks for it.
pub type StreamMaker = Arc<dyn Fn() -> Option<tokio::process::Command> + Send + Sync>;

/// One subtitle track, turned into WebVTT when first asked for.
pub struct Subtitles {
    pub film: String,
    pub source: SubtitleSource,
    /// Added to every cue: the subtitle delay, less where the stream starts in the film.
    pub shift: f64,
    converted: Mutex<Option<Arc<String>>>,
}

impl Subtitles {
    pub fn new(film: String, source: SubtitleSource, shift: f64) -> Self {
        Self {
            film,
            source,
            shift,
            converted: Mutex::new(None),
        }
    }

    fn webvtt(&self) -> Option<String> {
        let cached = self.converted.lock().clone();
        let text = match cached {
            Some(text) => text,
            None => {
                let mut command = tools::command(Tool::Ffmpeg)?;
                let output = command
                    .args(media::webvtt_args(&self.film, &self.source))
                    .output()
                    .ok()?;
                if !output.status.success() {
                    tracing::warn!(
                        error = %String::from_utf8_lossy(&output.stderr),
                        "subtitles could not be made into WebVTT"
                    );
                    return None;
                }
                let text = Arc::new(String::from_utf8_lossy(&output.stdout).into_owned());
                *self.converted.lock() = Some(text.clone());
                text
            }
        };
        Some(media::shift_webvtt(&text, self.shift))
    }
}

/// What is published under one token.
#[derive(Default)]
pub struct Published {
    /// Served as it is, at `/<token>/file`.
    pub file: Option<PathBuf>,
    /// Made by FFmpeg as it is read, at `/<token>/stream.mp4`.
    pub stream: Option<StreamMaker>,
    /// A folder FFmpeg writes HTTP Live Streaming into, at `/<token>/hls/…`.
    pub hls: Option<PathBuf>,
    /// At `/<token>/subs/<id>.vtt`.
    pub subtitles: HashMap<i32, Arc<Subtitles>>,
}

pub struct MediaServer {
    port: u16,
    routes: Arc<Mutex<HashMap<String, Arc<Published>>>>,
}

/// A new unguessable token.
pub fn token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Not secret, but still unique: the time.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        bytes = now.to_le_bytes();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The address of this Mac on the network that leads to `toward`: the one a
/// device there can reach it on. Nothing is sent.
pub fn local_address_toward(toward: IpAddr) -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(SocketAddr::new(toward, 9)).ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_unspecified() && !address.is_loopback()).then_some(address)
}

/// This Mac's address on the local network, for a device whose own address
/// is not known (AirPlay, where macOS does the talking).
pub fn local_address() -> Option<IpAddr> {
    local_address_toward(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251)))
        .or_else(|| local_address_toward(IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1))))
}

impl MediaServer {
    /// Starts listening on every interface, on a port the system picks.
    pub async fn start() -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        let port = listener.local_addr()?.port();
        let routes: Arc<Mutex<HashMap<String, Arc<Published>>>> = Arc::default();
        let server = Arc::new(Self {
            port,
            routes: routes.clone(),
        });
        tokio::spawn(async move {
            loop {
                let Ok((socket, peer)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    if let Err(error) = serve(socket, &routes).await {
                        tracing::debug!(%peer, %error, "a cast request ended early");
                    }
                });
            }
        });
        tracing::info!(port, "cast server listening");
        Ok(server)
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Publishes `what` under a new token and returns the token.
    pub fn publish(&self, what: Published) -> String {
        let token = token();
        self.routes.lock().insert(token.clone(), Arc::new(what));
        token
    }

    pub fn withdraw(&self, token: &str) {
        self.routes.lock().remove(token);
    }

    /// The address of `path` under `token`, as a device at `host` reaches it.
    pub fn url(&self, host: IpAddr, token: &str, path: &str) -> String {
        let host = match host {
            IpAddr::V6(v6) => format!("[{v6}]"),
            IpAddr::V4(v4) => v4.to_string(),
        };
        format!("http://{host}:{}/{token}/{path}", self.port)
    }
}

struct Request {
    method: String,
    path: String,
    range: Option<String>,
}

async fn read_request(socket: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(15), socket.read(&mut chunk))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "slow request"))??;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > 16 * 1024 {
            return Ok(None);
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_owned();
    let path = first.next().unwrap_or_default().to_owned();
    let mut range = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_owned());
            }
        }
    }
    Ok(Some(Request {
        method,
        path,
        range,
    }))
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n";

async fn head(
    socket: &mut TcpStream,
    status: &str,
    content_type: &str,
    length: Option<u64>,
    extra: &str,
) -> std::io::Result<()> {
    let length = length.map_or_else(String::new, |n| format!("Content-Length: {n}\r\n"));
    let text = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n{length}{extra}{CORS}Cache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    socket.write_all(text.as_bytes()).await
}

async fn status_only(socket: &mut TcpStream, status: &str) -> std::io::Result<()> {
    head(socket, status, "text/plain", Some(0), "").await
}

/// A byte range of a file `size` long, from a Range header.
fn byte_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (size.saturating_sub(n), size.checked_sub(1)?)
        }
        (start, "") => (start.parse().ok()?, size.checked_sub(1)?),
        (start, end) => (
            start.parse().ok()?,
            end.parse::<u64>().ok()?.min(size.checked_sub(1)?),
        ),
    };
    (start <= end && start < size).then_some((start, end))
}

async fn serve(
    mut socket: TcpStream,
    routes: &Mutex<HashMap<String, Arc<Published>>>,
) -> std::io::Result<()> {
    let _ = socket.set_nodelay(true);
    let Some(request) = read_request(&mut socket).await? else {
        return Ok(());
    };
    if request.method == "OPTIONS" {
        return head(&mut socket, "204 No Content", "text/plain", Some(0), "").await;
    }
    let only_head = request.method == "HEAD";
    if !only_head && request.method != "GET" {
        return status_only(&mut socket, "405 Method Not Allowed").await;
    }
    let path = request.path.split('?').next().unwrap_or_default();
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let token = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default();
    let Some(published) = routes.lock().get(token).cloned() else {
        return status_only(&mut socket, "404 Not Found").await;
    };

    if rest == "file" {
        if let Some(file) = &published.file {
            return serve_file(&mut socket, file, request.range.as_deref(), only_head).await;
        }
    } else if rest == "stream.mp4" {
        if let Some(maker) = &published.stream {
            return serve_stream(&mut socket, maker, only_head).await;
        }
    } else if let Some(name) = rest.strip_prefix("hls/") {
        if let Some(dir) = &published.hls {
            return serve_hls(&mut socket, dir, name, only_head).await;
        }
    } else if let Some(id) = rest
        .strip_prefix("subs/")
        .and_then(|name| name.strip_suffix(".vtt"))
        .and_then(|id| id.parse::<i32>().ok())
    {
        if let Some(subtitles) = published.subtitles.get(&id).cloned() {
            let text = tokio::task::spawn_blocking(move || subtitles.webvtt())
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "WEBVTT\n\n".to_owned());
            head(
                &mut socket,
                "200 OK",
                "text/vtt; charset=utf-8",
                Some(text.len() as u64),
                "",
            )
            .await?;
            if !only_head {
                socket.write_all(text.as_bytes()).await?;
            }
            return socket.flush().await;
        }
    }
    status_only(&mut socket, "404 Not Found").await
}

async fn serve_file(
    socket: &mut TcpStream,
    path: &std::path::Path,
    range: Option<&str>,
    only_head: bool,
) -> std::io::Result<()> {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return status_only(socket, "404 Not Found").await;
    };
    let size = file.metadata().await?.len();
    let kind = media::content_type(path);
    let (status, start, end, extra) = match range.map(|header| byte_range(header, size)) {
        Some(Some((start, end))) => (
            "206 Partial Content",
            start,
            end,
            format!("Accept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{size}\r\n"),
        ),
        Some(None) => {
            return head(
                socket,
                "416 Range Not Satisfiable",
                kind,
                Some(0),
                &format!("Content-Range: bytes */{size}\r\n"),
            )
            .await;
        }
        None => (
            "200 OK",
            0,
            size.saturating_sub(1),
            "Accept-Ranges: bytes\r\n".to_owned(),
        ),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    head(socket, status, kind, Some(length), &extra).await?;
    if only_head || length == 0 {
        return socket.flush().await;
    }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut limited = file.take(length);
    tokio::io::copy(&mut limited, socket).await?;
    socket.flush().await
}

async fn serve_stream(
    socket: &mut TcpStream,
    maker: &StreamMaker,
    only_head: bool,
) -> std::io::Result<()> {
    let extra = "Accept-Ranges: none\r\n";
    if only_head {
        return head(socket, "200 OK", "video/mp4", None, extra).await;
    }
    let Some(mut command) = maker() else {
        return status_only(socket, "503 Service Unavailable").await;
    };
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let Some(mut stdout) = child.stdout.take() else {
        return status_only(socket, "503 Service Unavailable").await;
    };
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut said = String::new();
            let _ = stderr.read_to_string(&mut said).await;
            if !said.trim().is_empty() {
                tracing::warn!(ffmpeg = %said.trim(), "the cast stream had trouble");
            }
        });
    }
    head(socket, "200 OK", "video/mp4", None, extra).await?;
    // Until the device hangs up, or FFmpeg is done. Dropping the child stops it.
    let copied = tokio::io::copy(&mut stdout, socket).await;
    let _ = child.start_kill();
    copied.map(|_| ())
}

/// The playlist as FFmpeg last wrote it, told to start at its beginning:
/// a playlist still being written is otherwise joined near its end.
fn playlist_from_start(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 48);
    for (n, line) in text.lines().enumerate() {
        out.push_str(line);
        out.push('\n');
        if n == 0 && line.starts_with("#EXTM3U") && !text.contains("#EXT-X-START") {
            out.push_str("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n");
        }
    }
    out
}

async fn serve_hls(
    socket: &mut TcpStream,
    dir: &std::path::Path,
    name: &str,
    only_head: bool,
) -> std::io::Result<()> {
    if name.is_empty() || name.contains('/') || name.contains("..") || name.ends_with(".tmp") {
        return status_only(socket, "404 Not Found").await;
    }
    let path = dir.join(name);
    if name.ends_with(".m3u8") {
        // FFmpeg may not have written the playlist yet.
        let mut text = None;
        for _ in 0..100 {
            if let Ok(read) = tokio::fs::read_to_string(&path).await {
                if read.contains("#EXTINF") {
                    text = Some(read);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let Some(text) = text else {
            return status_only(socket, "404 Not Found").await;
        };
        let body = playlist_from_start(&text);
        head(
            socket,
            "200 OK",
            "application/vnd.apple.mpegurl",
            Some(body.len() as u64),
            "",
        )
        .await?;
        if !only_head {
            socket.write_all(body.as_bytes()).await?;
        }
        return socket.flush().await;
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return status_only(socket, "404 Not Found").await;
    };
    head(socket, "200 OK", "video/mp4", Some(bytes.len() as u64), "").await?;
    if !only_head {
        socket.write_all(&bytes).await?;
    }
    socket.flush().await
}

/// How many seconds of a playlist FFmpeg has written so far, and whether it
/// has finished.
pub fn hls_progress(dir: &std::path::Path) -> (f64, bool) {
    let Ok(text) = std::fs::read_to_string(dir.join("index.m3u8")) else {
        return (0.0, false);
    };
    let seconds = text
        .lines()
        .filter_map(|line| line.strip_prefix("#EXTINF:"))
        .filter_map(|rest| rest.split(',').next()?.trim().parse::<f64>().ok())
        .sum();
    (seconds, text.contains("#EXT-X-ENDLIST"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_byte_ranges() {
        assert_eq!(byte_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(byte_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(byte_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=100-", 100), None);
        assert_eq!(byte_range("items=0-1", 100), None);
    }

    #[test]
    fn a_playlist_is_told_to_start_at_its_beginning() {
        let text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:4.0,\ns00000.m4s\n";
        let out = playlist_from_start(text);
        assert!(
            out.starts_with("#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-VERSION:7")
        );
    }

    async fn get(port: u16, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let range = range.map_or_else(String::new, |r| format!("Range: {r}\r\n"));
        socket
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n{range}\r\n").as_bytes())
            .await
            .unwrap();
        let mut all = Vec::new();
        socket.read_to_end(&mut all).await.unwrap();
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (
            String::from_utf8_lossy(&all[..split]).into_owned(),
            all[split + 4..].to_vec(),
        )
    }

    #[tokio::test]
    async fn serves_a_file_in_ranges_and_nothing_unpublished() {
        let dir = std::env::temp_dir().join(format!("lumen-cast-test-{}", token()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("film.mp4");
        std::fs::write(&file, b"0123456789").unwrap();
        let server = MediaServer::start().await.unwrap();
        let token = server.publish(Published {
            file: Some(file),
            ..Published::default()
        });

        let (head, body) = get(server.port(), &format!("/{token}/file"), Some("bytes=2-5")).await;
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 2-5/10"));
        assert!(head.contains("Access-Control-Allow-Origin: *"));
        assert_eq!(body, b"2345");

        let (head, body) = get(server.port(), &format!("/{token}/file"), None).await;
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body, b"0123456789");

        let (head, _) = get(server.port(), "/not-a-token/file", None).await;
        assert!(head.starts_with("HTTP/1.1 404"));
        server.withdraw(&token);
        let (head, _) = get(server.port(), &format!("/{token}/file"), None).await;
        assert!(head.starts_with("HTTP/1.1 404"));
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Serves a real film the way each kind of device gets it, for a browser
/// (Chromecast's engine) and AVFoundation (AirPlay's) to play. Run with
/// `LUMEN_CAST_FILM=<film> LUMEN_CAST_URLS=<file> cargo test --lib
/// serve_a_film_for_real_players -- --ignored --nocapture`; it serves for
/// `LUMEN_CAST_SECONDS` (default 120).
#[cfg(test)]
mod real {
    use super::*;
    use crate::cast::media::{self, Choice, Output, Probe, Profile, SubtitleSource, SubtitleTrack};

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "serves a real film for a real player"]
    async fn serve_a_film_for_real_players() {
        let film = std::env::var("LUMEN_CAST_FILM").expect("LUMEN_CAST_FILM");
        let urls = std::env::var("LUMEN_CAST_URLS").expect("LUMEN_CAST_URLS");
        let seconds: u64 = std::env::var("LUMEN_CAST_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(120);
        let probe = Probe::of(&film).unwrap();
        let subtitle = SubtitleTrack {
            id: 1,
            source: SubtitleSource::Embedded(0),
            text: true,
            name: "English".to_owned(),
            language: Some("eng".to_owned()),
        };
        let with_subs = Choice {
            subtitle: Some(1),
            ..Choice::default()
        };
        let start = 10.0;
        let cast = media::plan(
            &probe,
            Profile::Chromecast { hevc: false },
            &with_subs,
            std::slice::from_ref(&subtitle),
        );
        let air = media::plan(
            &probe,
            Profile::AirPlay,
            &with_subs,
            std::slice::from_ref(&subtitle),
        );
        println!(
            "chromecast: {:?} {:?} {:?}",
            cast.delivery, cast.video, cast.audio
        );
        println!(
            "airplay: {:?} {:?} burn={}",
            air.delivery,
            air.video,
            air.burn.is_some()
        );

        let server = MediaServer::start().await.unwrap();
        let mut published = Published::default();
        let (f, p) = (film.clone(), cast.clone());
        published.stream = Some(Arc::new(move || {
            let mut command = tokio::process::Command::from(tools::command(Tool::Ffmpeg)?);
            command.args(media::ffmpeg_args(&f, &p, start, 0.0, &Output::Fragmented));
            Some(command)
        }));
        published.subtitles.insert(
            1,
            Arc::new(Subtitles::new(
                film.clone(),
                SubtitleSource::Embedded(0),
                -start,
            )),
        );
        let dir = std::env::temp_dir().join(format!("lumen-hls-{}", token()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut hls = tokio::process::Command::from(tools::command(Tool::Ffmpeg).unwrap());
        hls.args(media::ffmpeg_args(
            &film,
            &air,
            start,
            0.0,
            &Output::Hls { dir: dir.clone() },
        ))
        .kill_on_drop(true);
        let _child = hls.spawn().unwrap();
        published.hls = Some(dir.clone());
        let token = server.publish(published);
        let host = local_address().unwrap();
        let text = format!(
            "{}\n{}\n{}\n",
            server.url(host, &token, "stream.mp4"),
            server.url(host, &token, "subs/1.vtt"),
            server.url(host, &token, "hls/index.m3u8")
        );
        std::fs::write(&urls, &text).unwrap();
        println!("{text}");
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
