use objc2::{
    rc::{Retained, autoreleasepool},
    runtime::{NSObjectProtocol, ProtocolObject},
};
use objc2_foundation::{NSActivityOptions, NSProcessInfo, ns_string};

pub(super) struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);

// The opaque token is only passed back to thread-safe NSProcessInfo.endActivity.
// All accesses, including its final release, are serialized by SHARED.
unsafe impl Send for Token {}

impl Token {
    pub(super) fn begin() -> Option<Self> {
        Some(Self(autoreleasepool(|_| {
            NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                ns_string!("Sending a file selected by the user"),
            )
        })))
    }

    pub(super) fn finish(self) {
        autoreleasepool(|_| {
            // SAFETY: this token came from beginActivity above and is ended exactly once.
            unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
            drop(self);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::{SendActivity, Shared};
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn concurrent_sends_share_the_token_until_the_last_guard_drops() {
        static TEST: Mutex<Shared> = Mutex::new(Shared {
            users: 0,
            token: None,
        });
        let first = SendActivity::begin_in(&TEST);
        let token_id = || {
            let state = TEST.lock().unwrap();
            state
                .token
                .as_ref()
                .map(|token| Retained::as_ptr(&token.0) as usize)
        };
        let id = token_id().unwrap();
        let second = std::thread::spawn(|| SendActivity::begin_in(&TEST))
            .join()
            .unwrap();
        drop(first);
        assert_eq!(token_id(), Some(id));
        std::thread::spawn(move || drop(second)).join().unwrap();
        assert!(token_id().is_none());
    }
}
