// E2E fixture source file (seam S8, the launch-cwd workspace).
//
// This is the "open a file" target for editor.e2e.ts: it sits at the workspace
// ROOT so it renders in the WorkspaceTree without expanding any folder, and it
// carries a distinctive marker the editor spec asserts on. It is also a real
// Rust file with a defined symbol + a caller, so a future LSP slice (seam S6)
// has something to resolve go-to-definition against.

/// A defined symbol a go-to-definition test can target. E2E_EDITOR_MARKER below
/// is what editor.e2e.ts looks for in the CodeMirror content.
pub fn greeting() -> &'static str {
    // E2E_EDITOR_MARKER: a stable, unique token the editor spec asserts is shown.
    "hello from the e2e fixture"
}

fn main() {
    // A caller of `greeting` (the find-usages / go-to-def edge, for a later slice).
    println!("{}", greeting());
}
