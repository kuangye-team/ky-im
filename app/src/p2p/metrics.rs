//! Opt-in aggregate timings; no payload or per-packet log retention.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    count: u64,
    bytes: u64,
    total_ms: f64,
    max_ms: f64,
    max_bytes: usize,
}
#[derive(Clone, Default)]
pub struct Metrics {
    enabled: Arc<AtomicBool>,
    samples: Arc<Mutex<(u64, BTreeMap<&'static str, Sample>)>>,
}
pub struct Timer {
    metrics: Metrics,
    key: &'static str,
    bytes: usize,
    start: Instant,
    generation: u64,
}
impl Metrics {
    pub fn configure(&self, enabled: Option<bool>, reset: bool) -> Value {
        let mut samples = self.samples.lock().unwrap();
        if reset {
            samples.0 += 1;
            samples.1.clear();
        }
        if let Some(enabled) = enabled {
            self.enabled.store(enabled, Ordering::Relaxed);
        }
        serde_json::to_value(&samples.1).unwrap()
    }
    pub fn timer(&self, key: &'static str, bytes: usize) -> Option<Timer> {
        self.enabled.load(Ordering::Relaxed).then(|| Timer {
            metrics: self.clone(),
            key,
            bytes,
            start: Instant::now(),
            generation: self.samples.lock().unwrap().0,
        })
    }
}
impl Drop for Timer {
    fn drop(&mut self) {
        if !self.metrics.enabled.load(Ordering::Relaxed) {
            return;
        }
        let ms = self.start.elapsed().as_secs_f64() * 1000.0;
        let mut samples = self.metrics.samples.lock().unwrap();
        if samples.0 != self.generation {
            return;
        }
        let sample = samples.1.entry(self.key).or_default();
        sample.count += 1;
        sample.bytes += self.bytes as u64;
        sample.total_ms += ms;
        sample.max_ms = sample.max_ms.max(ms);
        sample.max_bytes = sample.max_bytes.max(self.bytes);
    }
}
