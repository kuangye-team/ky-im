use proxyres::{config, resolver::Resolver};
use reqwest::{Client, Proxy, Url, redirect::Policy};
use reqwest_websocket::{Upgrade, WebSocket};
use std::time::Duration;
use tungstenite::protocol::WebSocketConfig;

fn system_routes(url: &Url) -> Result<Vec<String>, String> {
    // PAC scripts can distinguish ws from wss. Manual settings commonly expose
    // only HTTP(S) or SOCKS, so look up the matching proxy with the original host/port.
    let preferred = if url.scheme() == "wss" {
        ["https", "http", "socks"]
    } else {
        ["http", "https", "socks"]
    };
    let mut lookup = url.to_string();
    let mut bare_socks = false;
    if config::auto_config_url().is_none()
        && let Some((scheme, proxy)) = preferred
            .into_iter()
            .find_map(|scheme| config::proxy(scheme).map(|proxy| (scheme, proxy)))
    {
        let host = url.host_str().ok_or("Missing signaling host")?;
        let port = url
            .port_or_known_default()
            .ok_or("Missing signaling port")?;
        lookup = format!("{scheme}://{host}:{port}/");
        bare_socks = scheme == "socks" && !proxy.contains("://");
    }
    let mut resolver = Resolver::new();
    resolver
        .get_proxies_for_url(&lookup)
        .map_err(|e| e.to_string())?;
    if !resolver.wait(Some(Duration::from_secs(10))) {
        return Err("System proxy lookup timed out".into());
    }
    if let Some(error) = resolver.error() {
        return Err(error.to_string());
    }
    Ok(resolver
        .proxies()
        .into_iter()
        .map(|route| {
            // The resolver prefixes a bare manual proxy hostname with http://.
            if bare_socks && let Some(host) = route.strip_prefix("http://") {
                return format!("socks5h://{host}");
            }
            route.to_owned()
        })
        .collect())
}

async fn open(url: &Url, route: &str) -> Result<WebSocket, String> {
    // The resolver has already applied bypass rules. Do not apply a second proxy
    // from process environment variables or redirect the authenticated session.
    let mut client = Client::builder()
        .no_proxy()
        .http1_only()
        .redirect(Policy::none());
    if route != "direct://" {
        let proxy = match route
            .strip_prefix("socks://")
            .or_else(|| route.strip_prefix("socks5://"))
        {
            Some(host) => Proxy::all(format!("socks5h://{host}")),
            None => Proxy::all(route),
        }
        .map_err(|e| e.to_string())?;
        client = client.proxy(proxy);
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(512 * 1024))
        .max_frame_size(Some(512 * 1024));
    let response = client
        .build()
        .map_err(|e| e.to_string())?
        .get(url.clone())
        .upgrade()
        .web_socket_config(config)
        .send()
        .await
        .map_err(connection_error)?;
    response.into_websocket().await.map_err(|e| e.to_string())
}

fn connection_error(error: reqwest_websocket::Error) -> String {
    // Keep URLs (which can include a server key) out of diagnostics.
    use std::error::Error;
    let reqwest_websocket::Error::Reqwest(request) = error else {
        return error.to_string();
    };
    let request = request.without_url();
    let mut cause: &dyn Error = &request;
    while let Some(source) = cause.source() {
        cause = source;
    }
    cause.to_string()
}

pub(super) async fn connect(address: &str, use_system_proxy: bool) -> Result<WebSocket, String> {
    let url = Url::parse(address).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "ws" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid signaling URL".into());
    }
    if !use_system_proxy {
        return open(&url, "direct://").await;
    }
    let lookup = url.clone();
    let routes = tokio::task::spawn_blocking(move || system_routes(&lookup))
        .await
        .map_err(|e| e.to_string())??;
    let mut last_error = "No route to the signaling server".to_owned();
    for route in routes {
        match open(&url, &route).await {
            Ok(socket) => return Ok(socket),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}
