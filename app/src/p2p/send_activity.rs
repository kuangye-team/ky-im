//! Overlapping file sends share one process policy and allow idle system sleep.
use std::sync::Mutex;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::Token;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::Token;

#[derive(Default)]
struct Shared {
    users: usize,
    token: Option<Token>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    users: 0,
    token: None,
});

pub(super) struct SendActivity(&'static Mutex<Shared>);

impl SendActivity {
    pub fn begin() -> Self {
        Self::begin_in(&SHARED)
    }

    fn begin_in(shared: &'static Mutex<Shared>) -> Self {
        let mut state = shared.lock().unwrap();
        if state.users == 0 {
            state.token = Token::begin();
        }
        state.users += 1;
        Self(shared)
    }
}

impl Drop for SendActivity {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.users -= 1;
        if state.users == 0
            && let Some(token) = state.token.take()
        {
            token.finish();
        }
    }
}
