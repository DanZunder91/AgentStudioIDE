// E2E fixture (seam S8): the editor.e2e.ts open-a-file target. It sits at the workspace root so it
// shows without expanding a folder; the symbol and its caller are for a future LSP slice (seam S6).

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
