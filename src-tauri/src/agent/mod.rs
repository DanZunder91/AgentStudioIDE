//! Agent runtimes — the fan-out foundation (ARCHITECTURE §5).
//!
//! [`adapter`] is the runtime-agnostic seam every other module talks to;
//! [`claude`] is the only Claude-specific code in the core. M3's
//! transcript tailer plugs into the same trait.

pub mod adapter;
pub mod claude;
pub mod fanout;
pub mod hook;
pub mod tools;
