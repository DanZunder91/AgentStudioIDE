// src/lib/fileIcons/FileIcon.tsx
//
// The per-file colored icon (file-icons.md §6, files branch): resolves the
// basename through the §3 ladder and references the injected sprite via
// `<use href="#mi-<id>">` — the DOM re-uses one `<symbol>` per icon id no
// matter how many rows show it. Requires `<IconSprite>` mounted once app-level.
//
// `data-icon-id` is the test hook (the repo's `data-icon` precedent in
// src/components/icons.tsx): tests assert WHICH icon resolved without reaching
// into sprite path data — jsdom never paints `<use>` targets anyway.

import * as React from 'react';
import { resolveFileIconId } from './resolveIconId';

export interface FileIconProps {
  /** The file's basename, e.g. "Cargo.toml" (not a full path). */
  name: string;
  size?: number;
  className?: string;
}

// React.memo: the tree renders one of these per visible file row; rows
// re-render on selection/git/drag churn while `name` almost never changes.
export const FileIcon = React.memo(function FileIcon({
  name,
  size = 12,
  className,
}: FileIconProps): React.JSX.Element {
  const id = resolveFileIconId(name);
  return (
    <svg
      className={className ? `file-icon ${className}` : 'file-icon'}
      width={size}
      height={size}
      aria-hidden
      focusable={false}
      data-icon-id={id}
    >
      <use href={`#mi-${id}`} />
    </svg>
  );
});
