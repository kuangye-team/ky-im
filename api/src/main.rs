use im_api::{AppState, Config, router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    println!(
        "Send signaling service listening on http://{}",
        listener.local_addr()?
    );
    println!("Frontend directory: {}", config.static_dir.display());
    axum::serve(
        listener,
        router(AppState::new(config))?
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
