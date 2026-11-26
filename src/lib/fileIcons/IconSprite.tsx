// Injects the generated SVG sprite once (file-icons.md §4); mount exactly one, app-level. No
// DOMPurify on purpose: the sprite is our generator's output (scripts/icons rejects scripts and
// handlers), never user input; inject anything else and a sanitiser becomes mandatory.

import { useMemo } from 'react';
import type * as React from 'react';
import { FILE_ICON_SPRITE } from './sprite.generated';

// Hidden but RENDERED: never `display:none`, where some engines paint `<use>` symbols blank.
// Zero-size + overflow-hidden keeps it out of layout yet a live paint source.
const HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 0,
  height: 0,
  overflow: 'hidden',
};

export function IconSprite(): React.JSX.Element {
  // LOAD-BEARING: React 19 re-assigns innerHTML whenever the `dangerouslySetInnerHTML` object
  // identity changes, so an inline `{ __html }` would re-parse the sprite on every parent render.
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
