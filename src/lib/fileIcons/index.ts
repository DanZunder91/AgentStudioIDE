// src/lib/fileIcons/index.ts
//
// Public surface of the file-icon module (docs/design/file-icons.md).
// Consumers import from here; the *.generated.ts artifacts are owned by the
// icon generator (scripts/icons) and are re-exported, never edited.

export { FileIcon } from './FileIcon';
export type { FileIconProps } from './FileIcon';
export { IconSprite } from './IconSprite';
export { resolveFileIconId } from './resolveIconId';
export { ICON_MAP } from './iconMap.generated';
export type { IconMap } from './iconMap.generated';
export { FILE_ICON_SPRITE, SPRITE_ICON_IDS } from './sprite.generated';
