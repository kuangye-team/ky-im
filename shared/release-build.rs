pub fn release_version() {
    println!("cargo:rerun-if-env-changed=RELEASE_VERSION");
    let version = std::env::var("RELEASE_VERSION").unwrap_or_else(|_| "0.1.0".into());
    let version = version.trim().trim_start_matches('v');
    assert!(
        !version.is_empty()
            && version.len() <= 64
            && version.as_bytes()[0].is_ascii_alphanumeric()
            && version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b)),
        "Invalid RELEASE_VERSION"
    );
    println!("cargo:rustc-env=RELEASE_VERSION={version}");
}
