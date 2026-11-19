//! Finding cast devices on the local network, by multicast DNS: Google
//! Cast devices, and AirPlay receivers (Apple TVs, TVs with AirPlay, other
//! Macs). Bonjour supplies the receiver identity and network address
//! used for direct AirPlay routing and stream delivery.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use parking_lot::Mutex;

use super::CastDevice;

const GOOGLE_CAST: &str = "_googlecast._tcp.local.";
const AIRPLAY: &str = "_airplay._tcp.local.";

/// Reads an AirPlay receiver's TXT record into a device. `own` is this Mac's
/// name, which is not offered: a Mac cannot AirPlay to itself.
pub fn airplay_from(
    fullname: &str,
    property: impl Fn(&str) -> Option<String>,
    addresses: &[IpAddr],
    port: u16,
    own: &str,
) -> Option<Found> {
    let name = fullname
        .strip_suffix(&format!(".{AIRPLAY}"))?
        .replace("\\.", ".");
    let name = name.trim().to_owned();
    if name.is_empty() || name.eq_ignore_ascii_case(own.trim()) {
        return None;
    }
    // The features are a 64-bit mask, written as two 32-bit halves; bit 0 is video.
    let features = property("features").and_then(|text| {
        let mut halves = text
            .split(',')
            .map(|half| u64::from_str_radix(half.trim().trim_start_matches("0x"), 16).ok());
        let low = halves.next()??;
        let high = halves.next().flatten().unwrap_or(0);
        Some(low | (high << 32))
    });
    let video = features.is_none_or(|bits| bits & 1 == 1);
    let model = property("model").unwrap_or_default();
    let id = property("deviceid").unwrap_or_else(|| name.clone());
    let address = addresses
        .iter()
        .find(|ip| ip.is_ipv4())
        .or_else(|| addresses.first())
        .copied()?;
    Some(Found {
        device: CastDevice {
            id: format!("airplay:{id}"),
            name,
            model: airplay_kind(&model).to_owned(),
            protocol: super::CastProtocol::AirPlay,
            video,
        },
        address: SocketAddr::new(address, port),
        paired_video: model.starts_with("AppleTV")
            && property("osvers")
                .and_then(|v| v.split('.').next()?.parse::<u32>().ok())
                .is_some_and(|v| v >= 26),
        hevc: true,
    })
}

/// What an AirPlay receiver is, from its model identifier.
fn airplay_kind(model: &str) -> &str {
    if model.starts_with("AppleTV") {
        "Apple TV"
    } else if model.starts_with("AudioAccessory") {
        "HomePod"
    } else if model.starts_with("Mac") || model.starts_with("iMac") {
        "Mac"
    } else if model.is_empty() {
        "AirPlay"
    } else {
        "TV"
    }
}

/// This Mac's name, as it announces itself.
fn own_name() -> String {
    std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default()
}

type Reader = fn(&mdns_sd::ResolvedService, &str) -> Option<Found>;

fn read_cast(service: &mdns_sd::ResolvedService, _own: &str) -> Option<Found> {
    let addresses: Vec<IpAddr> = service
        .get_addresses()
        .iter()
        .map(|ip| ip.to_ip_addr())
        .collect();
    device_from(
        service.get_fullname(),
        |key| service.get_property_val_str(key).map(str::to_owned),
        &addresses,
        service.get_port(),
    )
}

fn read_airplay(service: &mdns_sd::ResolvedService, own: &str) -> Option<Found> {
    let addresses: Vec<IpAddr> = service
        .get_addresses()
        .iter()
        .map(|ip| ip.to_ip_addr())
        .collect();
    airplay_from(
        service.get_fullname(),
        |key| service.get_property_val_str(key).map(str::to_owned),
        &addresses,
        service.get_port(),
        own,
    )
}

/// A Cast device as found, with where to reach it.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub device: CastDevice,
    pub address: SocketAddr,
    pub paired_video: bool,
    /// It decodes HEVC (Chromecast Ultra, Google TV).
    pub hevc: bool,
}

/// Reads one service's TXT record into a device. `None` for what is not worth
/// listing.
pub fn device_from(
    fullname: &str,
    property: impl Fn(&str) -> Option<String>,
    addresses: &[IpAddr],
    port: u16,
) -> Option<Found> {
    let name = property("fn").filter(|name| !name.trim().is_empty())?;
    let model = property("md").unwrap_or_default();
    // Bit 0 of the capabilities is video out; groups and speakers lack it.
    let video = property("ca")
        .and_then(|ca| ca.parse::<u64>().ok())
        .is_none_or(|ca| ca & 1 == 1);
    let id = property("id").unwrap_or_else(|| fullname.to_owned());
    let address = addresses
        .iter()
        .find(|ip| ip.is_ipv4())
        .or_else(|| addresses.first())
        .copied()?;
    let lower = model.to_ascii_lowercase();
    let hevc = lower.contains("ultra") || lower.contains("google tv") || lower.contains("streamer");
    Some(Found {
        device: CastDevice {
            id: format!("cast:{id}"),
            name,
            model,
            protocol: super::CastProtocol::Chromecast,
            video,
        },
        address: SocketAddr::new(address, port),
        paired_video: false,
        hevc,
    })
}

pub struct Discovery {
    found: Arc<Mutex<HashMap<String, Found>>>,
    daemon: Mutex<Option<ServiceDaemon>>,
}

impl Discovery {
    pub fn new() -> Self {
        Self {
            found: Arc::default(),
            daemon: Mutex::new(None),
        }
    }

    /// Starts looking, if not already. `changed` is called whenever the list does.
    pub fn start(&self, changed: Arc<dyn Fn() + Send + Sync>) {
        let mut daemon = self.daemon.lock();
        if daemon.is_some() {
            return;
        }
        let service = match ServiceDaemon::new() {
            Ok(service) => service,
            Err(error) => {
                tracing::warn!(%error, "could not look for cast devices");
                return;
            }
        };
        let own: Arc<str> = own_name().into();
        for (kind, reader) in [
            (GOOGLE_CAST, read_cast as Reader),
            (AIRPLAY, read_airplay as Reader),
        ] {
            let events = match service.browse(kind) {
                Ok(events) => events,
                Err(error) => {
                    tracing::warn!(%error, kind, "could not look for cast devices");
                    continue;
                }
            };
            let found = self.found.clone();
            let changed = changed.clone();
            let own = own.clone();
            let spawned = std::thread::Builder::new()
                .name("lumen-cast-discovery".to_owned())
                .spawn(move || {
                    // Fullnames to device ids, so a removal can be matched.
                    let mut names: HashMap<String, String> = HashMap::new();
                    while let Ok(event) = events.recv() {
                        match event {
                            ServiceEvent::ServiceResolved(service) => {
                                let Some(device) = reader(&service, &own) else {
                                    continue;
                                };
                                names.insert(service.get_fullname().to_owned(), device.device.id.clone());
                                let fresh = found.lock().insert(device.device.id.clone(), device.clone());
                                if fresh.as_ref() != Some(&device) {
                                    tracing::info!(name = %device.device.name, model = %device.device.model, address = %device.address, "found a cast device");
                                    changed();
                                }
                            }
                            ServiceEvent::ServiceRemoved(_, fullname) => {
                                if let Some(id) = names.remove(&fullname) {
                                    if found.lock().remove(&id).is_some() {
                                        changed();
                                    }
                                }
                            }
                            ServiceEvent::SearchStopped(_) => break,
                            _ => {}
                        }
                    }
                });
            if let Err(error) = spawned {
                tracing::warn!(%error, "could not look for cast devices");
            }
        }
        *daemon = Some(service);
    }

    pub fn is_running(&self) -> bool {
        self.daemon.lock().is_some()
    }

    pub fn devices(&self) -> Vec<Found> {
        let mut all: Vec<Found> = self.found.lock().values().cloned().collect();
        all.sort_by_key(|found| found.device.name.to_lowercase());
        all
    }

    pub fn find(&self, id: &str) -> Option<Found> {
        self.found.lock().get(id).cloned()
    }

    pub fn stop(&self) {
        if let Some(daemon) = self.daemon.lock().take() {
            let _ = daemon.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn txt<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn reads_a_chromecast() {
        let ip: IpAddr = "192.168.1.40".parse().unwrap();
        let found = device_from(
            "Chromecast-abc._googlecast._tcp.local.",
            txt(&[
                ("fn", "Living Room TV"),
                ("md", "Chromecast Ultra"),
                ("id", "abc"),
                ("ca", "201221"),
            ]),
            &[ip],
            8009,
        )
        .unwrap();
        assert_eq!(found.device.name, "Living Room TV");
        assert_eq!(found.device.id, "cast:abc");
        assert!(found.device.video);
        assert!(found.hevc);
        assert_eq!(found.address, SocketAddr::new(ip, 8009));
    }

    #[test]
    fn a_speaker_has_no_picture() {
        let ip: IpAddr = "192.168.1.41".parse().unwrap();
        let found = device_from(
            "x",
            txt(&[
                ("fn", "Kitchen"),
                ("md", "Google Nest Mini"),
                ("ca", "199172"),
            ]),
            &[ip],
            8009,
        )
        .unwrap();
        assert!(!found.device.video);
        assert!(!found.hevc);
    }

    #[test]
    fn reads_an_apple_tv_and_leaves_out_this_mac_and_a_homepod_s_picture() {
        let ip: IpAddr = "192.168.1.50".parse().unwrap();
        let tv = airplay_from(
            "Living Room._airplay._tcp.local.",
            txt(&[
                ("model", "AppleTV14,1"),
                ("osvers", "27.2"),
                ("features", "0x5A7FFFF7,0x1E"),
                ("deviceid", "AA:BB"),
            ]),
            &[ip],
            7000,
            "Kumar’s MacBook Pro",
        )
        .unwrap();
        assert!(tv.paired_video);
        assert_eq!(tv.device.name, "Living Room");
        assert_eq!(tv.device.id, "airplay:AA:BB");
        assert_eq!(tv.device.model, "Apple TV");
        assert!(tv.device.video);
        let speaker = airplay_from(
            "Kitchen._airplay._tcp.local.",
            txt(&[
                ("model", "AudioAccessory5,1"),
                ("features", "0x4A7FCA00,0xBC354BD0"),
            ]),
            &[ip],
            7000,
            "Mac",
        )
        .unwrap();
        assert!(!speaker.device.video);
        assert_eq!(speaker.device.model, "HomePod");
        assert!(airplay_from(
            "Kumar’s MacBook Pro._airplay._tcp.local.",
            txt(&[("model", "Mac15,9")]),
            &[ip],
            7000,
            "Kumar’s MacBook Pro"
        )
        .is_none());
    }

    #[test]
    fn a_device_without_a_name_or_address_is_not_listed() {
        let ip: IpAddr = "192.168.1.41".parse().unwrap();
        assert!(device_from("x", txt(&[("md", "Chromecast")]), &[ip], 8009).is_none());
        assert!(device_from("x", txt(&[("fn", "TV")]), &[], 8009).is_none());
    }
}
