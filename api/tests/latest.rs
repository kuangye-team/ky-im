use axum::{
    Router,
    body::Body,
    http::{StatusCode, header},
    routing::get,
};
use im_api::{AppState, Config, router};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (address, task)
}

#[tokio::test]
async fn latest_uses_configured_upstream_caches_and_removes_the_old_endpoint() {
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let manifest = br#"{"version":"1.2.3","platforms":{},"downloads":{"windows":"https://example.com/app.exe"}}"#;
    let (upstream, upstream_task) = serve(
        Router::new()
            .route(
                "/redirect",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/custom.json")]) }),
            )
            .route(
                "/custom.json",
                get(move || {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        // Exercise manifests without a Content-Length header as well.
                        Body::from_stream(futures_util::stream::iter([
                            Ok::<_, std::io::Error>(&manifest[..20]),
                            Ok(&manifest[20..]),
                        ]))
                    }
                }),
            )
            .route("/invalid.json", get(|| async { "not json" }))
            .route(
                "/failure.json",
                get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
            ),
    )
    .await;
    let config = Config {
        latest_json_url: format!("{upstream}/redirect").parse().unwrap(),
        authorization: "private-api-key".into(),
        ..Config::default()
    };
    let (api, api_task) = serve(router(AppState::new(config)).unwrap()).await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::new();
    for path in [
        "/api/latest",
        "/api/latest?source=http://unused.invalid/override.json",
    ] {
        let response = client.get(format!("{api}{path}")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=300"
        );
        assert_eq!(response.bytes().await.unwrap().as_ref(), manifest);
    }
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        client
            .get(format!("{api}/api/client-release"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    for path in ["invalid.json", "failure.json"] {
        let (failed_api, failed_task) = serve(
            router(AppState::new(Config {
                latest_json_url: format!("{upstream}/{path}").parse().unwrap(),
                ..Config::default()
            }))
            .unwrap(),
        )
        .await;
        let response = client
            .get(format!("{failed_api}/api/latest"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        failed_task.abort();
    }
    api_task.abort();
    upstream_task.abort();
}
