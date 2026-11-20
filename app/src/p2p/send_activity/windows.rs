use ::windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessInformation, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED as SPEED, PROCESS_POWER_THROTTLING_STATE,
    ProcessPowerThrottling, SetProcessInformation,
};
use ::windows::core::Result;
use std::mem::size_of_val;

pub(super) struct Token(PROCESS_POWER_THROTTLING_STATE);

fn current_policy() -> Result<PROCESS_POWER_THROTTLING_STATE> {
    let mut policy = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ..Default::default()
    };
    // SAFETY: the current-process pseudo-handle is valid and the buffer matches the class.
    unsafe {
        GetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            (&raw mut policy).cast(),
            size_of_val(&policy) as u32,
        )?;
    }
    Ok(policy)
}

fn set_policy(policy: &PROCESS_POWER_THROTTLING_STATE) -> Result<()> {
    // SAFETY: Windows reads the supplied structure during this call.
    unsafe {
        SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            std::ptr::from_ref(policy).cast(),
            size_of_val(policy) as u32,
        )
    }
}

impl Token {
    pub(super) fn begin() -> Option<Self> {
        let previous = current_policy().ok()?;
        // The async sender moves between threads. Request HighQoS for the native process.
        let active = PROCESS_POWER_THROTTLING_STATE {
            ControlMask: previous.ControlMask | SPEED,
            StateMask: previous.StateMask & !SPEED,
            ..previous
        };
        if active == previous {
            return None;
        }
        set_policy(&active).ok()?;
        Some(Self(previous))
    }

    pub(super) fn finish(self) {
        let previous = self.0;
        let Ok(mut current) = current_policy() else {
            let _ = set_policy(&previous);
            return;
        };
        // Preserve other policy changes (e.g. timer resolution) during the send.
        if current.ControlMask & SPEED != 0 && current.StateMask & SPEED == 0 {
            current.ControlMask = (current.ControlMask & !SPEED) | (previous.ControlMask & SPEED);
            current.StateMask = (current.StateMask & !SPEED) | (previous.StateMask & SPEED);
            let _ = set_policy(&current);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_qos_is_scoped_to_the_send_and_preserves_other_throttling_flags() {
        // Serialize the real process policy with any file sends in the test runner.
        let _shared = super::super::SHARED.lock().unwrap();
        let Ok(previous) = current_policy() else {
            // Older versions can set a policy but cannot report the one to restore.
            assert!(Token::begin().is_none());
            return;
        };
        let token = Token::begin();
        let active = current_policy().unwrap();
        if let Some(token) = token {
            token.finish();
        }
        let restored = current_policy().unwrap();
        assert_eq!(active.ControlMask, previous.ControlMask | SPEED);
        assert_eq!(
            active.StateMask & active.ControlMask,
            previous.StateMask & previous.ControlMask & !SPEED
        );
        assert_eq!(restored.ControlMask, previous.ControlMask);
        assert_eq!(
            restored.StateMask & restored.ControlMask,
            previous.StateMask & previous.ControlMask
        );
    }
}
