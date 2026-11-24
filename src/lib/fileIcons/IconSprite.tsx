// src/lib/fileIcons/IconSprite.tsx
//
// Injects the generated inline SVG sprite ONCE into the DOM (file-icons.md §4):
// every `<symbol id="mi-<id>">` becomes referenceable by any number of
// `<FileIcon>`s via `<use href="#mi-<id>">`. Mount exactly one instance,
// app-level, before/alongside the tree.
//
// Sanitisation: the sprite is OUR OWN generated artifact — the generator
// (scripts/icons) refuses script/event-handler content at build time, and the
// string never contains user input — so there is deliberately no DOMPurify
// pass here. If this ever injects anything not produced by our generator,
// that reasoning is void and a sanitiser becomes mandatory.

import { useMemo } from 'react';
import type * as React from 'react';
import { FILE_ICON_SPRITE } from './sprite.generated';

// Visually hidden but RENDERED: `display:none` must not be used — some engines
// resolve `<use>` against display:none subtrees inconsistently (symbols would
// paint blank). Zero-size + overflow-hidden keeps the sprite out of layout
// while staying a live paint source.
const HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 0,
  height: 0,
  overflow: 'hidden',
};

export function IconSprite(): React.JSX.Element {
  // LOAD-BEARING, not a render optimisation: React 19 re-assigns
  // `innerHTML` whenever the `dangerouslySetInnerHTML` PROP OBJECT identity
  // changes (a reference check, no string comparison). An inline `{ __html }`
  // is a fresh object every render, so any parent re-render would wipe and
  // re-parse the sprite subtree. Memoised once ([] — the sprite is a module
  // constant), React never touches the subtree after mount.
  const html = useMemo(() => ({ __html: FILE_ICON_SPRITE }), []);
  return (
    <div
      data-testid="file-icon-sprite"
      aria-hidden
      style={HIDDEN}
      dangerouslySetInnerHTML={html} // MUST stay the memoised object — never inline `{{ __html: … }}`
    />
  );
}
