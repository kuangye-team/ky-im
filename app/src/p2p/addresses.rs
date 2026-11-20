use if_addrs::IfAddr;
use libp2p::{Multiaddr, multiaddr::Protocol};
use std::net::Ipv4Addr;

fn host_address(ip: Ipv4Addr, mask: Ipv4Addr) -> bool {
    let host_bits = !u32::from(mask);
    let host = u32::from(ip) & host_bits;
    host_bits <= 1 || (host != 0 && host != host_bits)
}

/// A signal has no interface scope or netmask. Classify on the announcing device.
pub(super) fn usable(address: &Multiaddr, loopback: bool) -> bool {
    match address.iter().next() {
        Some(Protocol::Ip4(ip)) if ip.is_loopback() => loopback,
        Some(Protocol::Ip4(ip)) => {
            if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
                return false;
            }
            let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
            let mut masks = interfaces
                .iter()
                .filter_map(|iface| match &iface.addr {
                    IfAddr::V4(v4) if v4.ip == ip => Some(v4.netmask),
                    _ => None,
                })
                .peekable();
            masks.peek().is_none() || masks.any(|mask| host_address(ip, mask))
        }
        Some(Protocol::Ip6(ip)) => {
            !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unicast_link_local()
                && (loopback || !ip.is_loopback())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_hosts_from_subnet_and_broadcast_addresses() {
        let mask = Ipv4Addr::new(255, 255, 255, 0);
        assert!(!host_address("192.168.148.0".parse().unwrap(), mask));
        assert!(!host_address("192.168.148.255".parse().unwrap(), mask));
        let ip = "192.168.149.0".parse().unwrap();
        for mask in ["255.255.254.0", "255.255.255.254", "255.255.255.255"] {
            assert!(host_address(ip, mask.parse().unwrap()));
        }
    }
    #[test]
    fn loopback_is_optional_across_transports() {
        for addr in [
            "/ip4/127.1.2.3/tcp/1",
            "/ip6/::1/udp/1/quic-v1/webtransport",
        ] {
            let addr = addr.parse().unwrap();
            assert!(!usable(&addr, false));
            assert!(usable(&addr, true));
        }
        for addr in [
            "/ip4/0.0.0.0/tcp/1",
            "/ip6/fe80::1/tcp/1",
            "/ip4/224.0.0.1/tcp/1",
        ] {
            assert!(!usable(&addr.parse().unwrap(), true));
        }
    }
}
