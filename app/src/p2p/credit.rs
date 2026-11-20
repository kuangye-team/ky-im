use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub const RECEIVE_CREDITS: usize = 4;
/// Cumulative acknowledgments cannot create extra permits through duplicates or reordering.
pub struct ReceiveCredit {
    slots: Arc<Semaphore>,
    sequence: Mutex<(u64, u64)>, // sent, consumed
    pub closed: CancellationToken,
}
impl Default for ReceiveCredit {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(RECEIVE_CREDITS)),
            sequence: Mutex::new((0, 0)),
            closed: CancellationToken::new(),
        }
    }
}
impl ReceiveCredit {
    pub async fn acquire(&self) -> Result<OwnedSemaphorePermit, String> {
        self.slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Receive stream closed".into())
    }
    pub fn sent(&self, permit: OwnedSemaphorePermit) -> u64 {
        let mut state = self.sequence.lock().unwrap();
        state.0 += 1;
        permit.forget();
        state.0
    }
    pub fn consumed(&self, sequence: u64) -> Result<(), String> {
        let mut state = self.sequence.lock().unwrap();
        if sequence > state.0 {
            return Err("Invalid receive credit".into());
        }
        if sequence > state.1 {
            self.slots.add_permits((sequence - state.1) as usize);
            state.1 = sequence;
        }
        Ok(())
    }
    pub fn close(&self) {
        self.slots.close();
        self.closed.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cumulative_credit_is_bounded_and_rejects_future_acknowledgments() {
        let credit = ReceiveCredit::default();
        for sequence in 1..=4 {
            assert_eq!(credit.sent(credit.acquire().await.unwrap()), sequence);
        }
        assert_eq!(credit.slots.available_permits(), 0);
        assert!(credit.consumed(5).is_err());
        assert_eq!(credit.slots.available_permits(), 0);
        credit.consumed(2).unwrap();
        credit.consumed(2).unwrap();
        credit.consumed(1).unwrap();
        assert_eq!(credit.slots.available_permits(), 2);
        credit.consumed(4).unwrap();
        assert_eq!(credit.slots.available_permits(), RECEIVE_CREDITS);
    }
    #[tokio::test]
    async fn close_wakes_a_blocked_reader() {
        let credit = Arc::new(ReceiveCredit::default());
        for _ in 0..4 {
            credit.sent(credit.acquire().await.unwrap());
        }
        let task = {
            let credit = credit.clone();
            tokio::spawn(async move { credit.acquire().await })
        };
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        credit.close();
        assert!(task.await.unwrap().is_err());
    }
}
