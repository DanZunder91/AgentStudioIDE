//! Agent runtimes (ARCHITECTURE §5). [`adapter`] is the runtime-agnostic seam every module uses;
//! [`claude`] is the only Claude-specific code in the core.

pub mod adapter;
pub mod claude;
pub mod fanout;
pub mod hook;
pub mod tools;
