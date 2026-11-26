// Per-file icon (file-icons.md §6): resolves the basename via the §3 ladder and references the
// sprite via `<use href="#mi-<id>">`; needs `<IconSprite>` mounted once. `data-icon-id` is the
// test hook: jsdom never paints `<use>` targets.

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
