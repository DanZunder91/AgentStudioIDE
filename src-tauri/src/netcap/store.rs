//! The in-memory flow ring (cap [`RING_CAP`]) plus the dirty set the emitter drains. Nothing
//! here touches disk: bodies and headers live only as long as the app (they hold secrets).

use std::collections::{BTreeSet, VecDeque};

use super::types::FlowSummary;

/// Flows kept before the oldest is evicted.
pub const RING_CAP: usize = 5_000;
/// Per-side body capture cap.
pub const BODY_CAP: usize = 1 << 20;

/// A captured body: the first [`BODY_CAP`] bytes plus the true wire size.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Captured {
    pub bytes: Vec<u8>,
    pub size: u64,
    pub truncated: bool,
}

impl Captured {
    /// Append a chunk, keeping at most `cap` bytes but counting all of them.
    pub fn push(&mut self, chunk: &[u8], cap: usize) {
        self.size += chunk.len() as u64;
        let room = cap.saturating_sub(self.bytes.len());
        if chunk.len() > room {
            self.truncated = true;
        }
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}

/// Everything we keep about one flow.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowRecord {
    pub summary: FlowSummary,
    pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>,
    pub response_trailers: Vec<(String, String)>,
    pub request_body: Option<Captured>,
    pub response_body: Option<Captured>,
    /// The response `content-encoding`, kept so the detail view can decode lazily.
    pub response_encoding: Option<String>,
}

pub struct Store {
    flows: VecDeque<FlowRecord>,
    next_id: u64,
    dirty: BTreeSet<u64>,
    cap: usize,
}

impl Default for Store {
    fn default() -> Self {
        Self::with_cap(RING_CAP)
    }
}

impl Store {
    pub fn with_cap(cap: usize) -> Self {
        Store {
            flows: VecDeque::new(),
            next_id: 1,
            dirty: BTreeSet::new(),
            cap: cap.max(1),
        }
    }

    /// Insert a new flow, assigning its id (monotonic for the life of the store, surviving
    /// [`Store::clear`]). Evicts the oldest past the cap.
    pub fn insert(&mut self, mut summary: FlowSummary) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        summary.id = id;
        self.flows.push_back(FlowRecord {
            summary,
            request_headers: Vec::new(),
            response_headers: Vec::new(),
            response_trailers: Vec::new(),
            request_body: None,
            response_body: None,
            response_encoding: None,
        });
        while self.flows.len() > self.cap {
            if let Some(gone) = self.flows.pop_front() {
                self.dirty.remove(&gone.summary.id);
            }
        }
        self.dirty.insert(id);
        id
    }

    fn index(&self, id: u64) -> Option<usize> {
        // Ids are pushed in increasing order, so the deque is sorted by id.
        self.flows.binary_search_by_key(&id, |r| r.summary.id).ok()
    }

    /// Mutate a flow in place and mark it for the next emit. `false` when it was evicted or
    /// cleared — a late update for a gone flow is dropped, never resurrected.
    pub fn update(&mut self, id: u64, f: impl FnOnce(&mut FlowRecord)) -> bool {
        match self.index(id) {
            Some(i) => {
                f(&mut self.flows[i]);
                self.dirty.insert(id);
                true
            }
            None => false,
        }
    }

    pub fn get(&self, id: u64) -> Option<&FlowRecord> {
        self.index(id).map(|i| &self.flows[i])
    }

    pub fn snapshot(&self) -> Vec<FlowSummary> {
        self.flows.iter().map(|r| r.summary.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.flows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.flows.is_empty()
    }

    pub fn clear(&mut self) {
        self.flows.clear();
        self.dirty.clear();
    }

    /// Summaries of every flow changed since the last call, oldest first.
    pub fn take_dirty(&mut self) -> Vec<FlowSummary> {
        let ids = std::mem::take(&mut self.dirty);
        ids.into_iter()
            .filter_map(|id| self.get(id).map(|r| r.summary.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::FlowProto;
    use super::*;

    fn row(path: &str) -> FlowSummary {
        FlowSummary::pending(FlowProto::Http, "GET", "h", 80, path)
    }

    #[test]
    fn the_ring_keeps_the_newest_cap_flows() {
        let mut s = Store::with_cap(3);
        for i in 0..5 {
            s.insert(row(&format!("/{i}")));
        }
        let ids: Vec<u64> = s.snapshot().iter().map(|f| f.id).collect();
        assert_eq!(ids, [3, 4, 5]);
        assert!(s.get(1).is_none());
        assert!(
            !s.update(1, |_| {}),
            "an evicted flow must not be updatable"
        );
    }

    #[test]
    fn the_default_cap_is_five_thousand() {
        let mut s = Store::default();
        for _ in 0..5_001 {
            s.insert(row("/"));
        }
        assert_eq!(s.len(), 5_000);
        assert_eq!(s.snapshot()[0].id, 2);
    }

    #[test]
    fn ids_keep_increasing_across_a_clear() {
        let mut s = Store::with_cap(10);
        s.insert(row("/a"));
        s.clear();
        assert!(s.is_empty());
        assert_eq!(s.insert(row("/b")), 2);
    }

    #[test]
    fn dirty_is_drained_once_in_id_order_and_skips_evicted() {
        let mut s = Store::with_cap(2);
        let a = s.insert(row("/a"));
        let b = s.insert(row("/b"));
        s.update(a, |r| r.summary.status = Some(200));
        let batch = s.take_dirty();
        assert_eq!(batch.iter().map(|f| f.id).collect::<Vec<_>>(), [a, b]);
        assert_eq!(batch[0].status, Some(200));
        assert!(s.take_dirty().is_empty());
        s.insert(row("/c")); // evicts a
        s.update(a, |_| {});
        assert_eq!(s.take_dirty().len(), 1);
    }

    #[test]
    fn capture_counts_everything_but_keeps_only_the_cap() {
        let mut c = Captured::default();
        c.push(b"hello", 8);
        assert!(!c.truncated);
        c.push(b"world", 8);
        assert_eq!(c.bytes, b"hellowor");
        assert_eq!(c.size, 10);
        assert!(c.truncated);
    }
}
