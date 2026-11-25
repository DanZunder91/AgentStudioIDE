//! The tool tables, one module per area of the app. Each exports `pub const TOOLS: &[ToolSpec]`,
//! which [`super::registry::all`] collects.

pub mod db;
pub mod http;
pub mod stream;
