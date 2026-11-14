//! Finding Google Cast devices on the local network, by multicast DNS.
//!
//! AirPlay devices are not looked for here: macOS lists them itself, in its
//! own picker, which also handles their passwords and codes.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use parking_lot::Mutex;

use super::CastDevice;

const GOOGLE_CAST: &str = "_googlecast._tcp.local.";

/// A Cast device as found, with where to reach it.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub device: CastDevice,
    pub address: SocketAddr,
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
        let started = ServiceDaemon::new().and_then(|d| d.browse(GOOGLE_CAST).map(|r| (d, r)));
        let (service, events) = match started {
            Ok(started) => started,
            Err(error) => {
                tracing::warn!(%error, "could not look for cast devices");
                return;
            }
        };
        *daemon = Some(service);
        let found = self.found.clone();
        let spawned = std::thread::Builder::new()
            .name("lumen-cast-discovery".to_owned())
            .spawn(move || {
                // Fullnames to device ids, so a removal can be matched.
                let mut names: HashMap<String, String> = HashMap::new();
                while let Ok(event) = events.recv() {
                    match event {
                        ServiceEvent::ServiceResolved(service) => {
                            let addresses: Vec<IpAddr> =
                                service.get_addresses().iter().map(|ip| ip.to_ip_addr()).collect();
                            let Some(device) = device_from(
                                service.get_fullname(),
                                |key| service.get_property_val_str(key).map(str::to_owned),
                                &addresses,
                                service.get_port(),
                            ) else {
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
    fn a_device_without_a_name_or_address_is_not_listed() {
        let ip: IpAddr = "192.168.1.41".parse().unwrap();
        assert!(device_from("x", txt(&[("md", "Chromecast")]), &[ip], 8009).is_none());
        assert!(device_from("x", txt(&[("fn", "TV")]), &[], 8009).is_none());
    }
}
