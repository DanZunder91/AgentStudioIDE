/** Rail library of SAVED HTTP/WS/gRPC requests (app-data store, never the repo): read/open/delete
 * only (save is Cmd/Ctrl+S). No `folderId` = root (no migration); deleting a folder returns its
 * requests to the root. DnD follows `<FolderGroupRow/>` (private MIME per kind, `…-id:` marker). */

import { useEffect, useState, type DragEvent } from "react";

import { useAppStore } from "../../app/store";
import { modKey } from "../shortcuts/shortcuts";
import { loadApiStore, type ApiFolder, type SavedRequest } from "./apiStoreIpc";
import "./api.css";
import "./history.css";

/** Drag payload for filing a saved request: the VALUE is the request's id. */
export const REQUEST_DND_MIME = "application/x-agentstudio-saved-request";

/** Drag payload for reordering a folder: the VALUE is the folder's id. */
export const API_FOLDER_DND_MIME = "application/x-agentstudio-api-folder";

/** A dragover-readable marker of the dragged folder's id, so a row can spot itself. Lowercased:
 * HTML5 DnD lowercases every format string. */
export function apiFolderIdType(id: string): string {
  return `${API_FOLDER_DND_MIME}-id:${id}`.toLowerCase();
}

/** The short badge for a saved request: the HTTP method, or the protocol name. */
function badge(c: SavedRequest): string {
  if (c.protocol === "grpc") return "gRPC";
  if (c.protocol === "ws") return "WS";
  return c.method || "GET";
}

/** The secondary line: the URL, plus the picked method for a gRPC entry. */
function subtitle(c: SavedRequest): string {
  if (c.protocol === "grpc" && c.grpcService && c.grpcMethod) {
    return `${c.url} · ${c.grpcService}/${c.grpcMethod}`;
  }
  return c.url;
}

/** One saved-request row: open on click, delete on ✕, draggable into a folder. */
function RequestRow({ c }: { c: SavedRequest }): React.JSX.Element {
  const openSavedRequest = useAppStore((s) => s.apiActions.openSavedRequest);
  const deleteCollection = useAppStore((s) => s.apiActions.deleteCollection);

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(REQUEST_DND_MIME, c.id);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <li
      className="api-collection-row"
      data-testid="collections-row"
      draggable
      onDragStart={onDragStart}
    >
      <button
        type="button"
        className="api-collection-row__load"
        title={`Open ${c.name}`}
        onClick={() => openSavedRequest(c.id)}
      >
        <span
          className={`api-collection-row__method api-proto--${c.protocol ?? "http"}`}
        >
          {badge(c)}
        </span>
        <span className="api-collection-row__name">{c.name}</span>
        <span className="api-collection-row__url" title={subtitle(c)}>
          {subtitle(c)}
        </span>
      </button>
      <button
        type="button"
        className="api-header-row__remove"
        aria-label={`Delete ${c.name}`}
        title="Delete saved request"
        onClick={() => deleteCollection(c.id)}
      >
        ✕
      </button>
    </li>
  );
}

/** One folder: a disclosure header (rename/delete/drop target) plus its requests. */
function FolderRow({
  folder,
  requests,
}: {
  folder: ApiFolder;
  requests: SavedRequest[];
}): React.JSX.Element {
  const collapsed = useAppStore((s) => s.collapsedApiFolders.has(folder.id));
  const toggle = useAppStore((s) => s.apiActions.toggleApiFolderCollapsed);
  const renameFolder = useAppStore((s) => s.apiActions.renameApiFolder);
  const deleteFolder = useAppStore((s) => s.apiActions.deleteApiFolder);
  const moveRequest = useAppStore((s) => s.apiActions.moveRequestToFolder);
  const moveFolder = useAppStore((s) => s.apiActions.moveApiFolder);

  // Local chrome only: the rename box and the drop highlight. Never persisted, and
  // never set during render.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState(false);

  /** A request drag, or a folder drag from a DIFFERENT folder (self is suppressed). */
  const accepts = (e: DragEvent) =>
    e.dataTransfer.types.includes(REQUEST_DND_MIME) ||
    (e.dataTransfer.types.includes(API_FOLDER_DND_MIME) &&
      !e.dataTransfer.types.includes(apiFolderIdType(folder.id)));

  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropTarget(false);
  };

  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    setDropTarget(false);
    const request = e.dataTransfer.getData(REQUEST_DND_MIME);
    if (request) {
      void moveRequest(request, folder.id);
      return;
    }
    const dragged = e.dataTransfer.getData(API_FOLDER_DND_MIME);
    // A self-drop is a no-op: `moveBefore(list, x, x)` would send it to the end.
    if (dragged && dragged !== folder.id) void moveFolder(dragged, folder.id);
  };

  /** Commit the rename box (value passed in, so no unreachable `null` guard). The store drops a
   * blank name before Rust, so an empty box is a cancel. */
  const commitRename = (value: string) => {
    void renameFolder(folder.id, value);
    setRenaming(null);
  };

  return (
    <li
      className={`api-folder${dropTarget ? " api-folder--drop" : ""}`}
      data-testid="collections-folder"
      data-folder-id={folder.id}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className="api-folder__head"
        draggable={renaming === null}
        onDragStart={(e) => {
          e.dataTransfer.setData(API_FOLDER_DND_MIME, folder.id);
          // Empty value: read on `dragover` to suppress the self-drop indicator.
          e.dataTransfer.setData(apiFolderIdType(folder.id), "");
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <button
          type="button"
          className="api-folder__disclose"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${folder.name}`}
          onClick={() => toggle(folder.id)}
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          {renaming === null && (
            <span className="api-folder__name">{folder.name}</span>
          )}
          <span className="api-folder__count">{requests.length}</span>
        </button>
        {renaming !== null && (
          <input
            className="api-folder__rename"
            aria-label={`Rename ${folder.name}`}
            value={renaming}
            autoFocus
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => commitRename(renaming)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(renaming);
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        )}
        <button
          type="button"
          className="api-header-row__remove"
          aria-label={`Rename folder ${folder.name}`}
          title="Rename folder"
          onClick={() => setRenaming(folder.name)}
        >
          ✎
        </button>
        <button
          type="button"
          className="api-header-row__remove"
          aria-label={`Delete folder ${folder.name}`}
          // Said in the tooltip because it is the non-obvious half, and the user's
          // saved work is what is at stake if anyone assumes the other behaviour.
          title="Delete folder — its saved requests move back to the root"
          onClick={() => void deleteFolder(folder.id)}
        >
          ✕
        </button>
      </div>

      {!collapsed && (
        <ul className="api-collections" data-testid="collections-folder-body">
          {requests.length === 0 ? (
            <li className="api-folder__hint">
              Empty — drag a saved request here.
            </li>
          ) : (
            requests.map((c) => <RequestRow c={c} key={c.id} />)
          )}
        </ul>
      )}
    </li>
  );
}

export function CollectionsPanel(): React.JSX.Element {
  const collections = useAppStore((s) => s.apiCollections);
  const folders = useAppStore((s) => s.apiFolders);
  const hydrateApiStore = useAppStore((s) => s.apiActions.hydrateApiStore);
  const createFolder = useAppStore((s) => s.apiActions.createApiFolder);
  const moveRequest = useAppStore((s) => s.apiActions.moveRequestToFolder);

  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [rootDrop, setRootDrop] = useState(false);

  useEffect(() => {
    if (useAppStore.getState().apiStoreLoaded) return;
    let cancelled = false;
    void loadApiStore().then((store) => {
      if (!cancelled) hydrateApiStore(store);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateApiStore]);

  // Root = requests not in an EXISTING folder (computed). The `!folderIds.has` half matters: a
  // request pointing at a missing folder would otherwise render nowhere and look deleted.
  const folderIds = new Set(folders.map((f) => f.id));
  const rootRequests = collections.filter(
    (c) => c.folderId === undefined || !folderIds.has(c.folderId),
  );

  const onRootDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(REQUEST_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setRootDrop(true);
  };

  const onRootDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(REQUEST_DND_MIME)) return;
    e.preventDefault();
    setRootDrop(false);
    const request = e.dataTransfer.getData(REQUEST_DND_MIME);
    if (request) void moveRequest(request, null);
  };

  /** Commit the new-folder box — value in, for the same reason `commitRename` takes one. */
  const commitNewFolder = (value: string) => {
    void createFolder(value);
    setNewFolder(null);
  };

  return (
    <div className="history-panel" data-testid="collections-panel">
      <div className="history-panel__head">
        <p className="history-panel__note">
          Saved requests — HTTP, WebSocket, and gRPC (stored in the app data dir, never
          the repo). Click one to open it; save the active request with{" "}
          <kbd>{modKey()}</kbd>+<kbd>S</kbd>. Drag a request onto a folder to
          group it.
        </p>
        {newFolder === null ? (
          <button
            type="button"
            className="api-folder__new"
            onClick={() => setNewFolder("")}
          >
            + New folder
          </button>
        ) : (
          <input
            className="api-folder__rename"
            aria-label="New folder name"
            placeholder="Folder name"
            value={newFolder}
            autoFocus
            onChange={(e) => setNewFolder(e.target.value)}
            onBlur={() => commitNewFolder(newFolder)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNewFolder(newFolder);
              if (e.key === "Escape") setNewFolder(null);
            }}
          />
        )}
      </div>

      {collections.length === 0 && folders.length === 0 ? (
        <p className="history-panel__empty" data-testid="collections-empty">
          No saved requests yet. Compose one in an API request tab and press {modKey()}+S to
          save it here.
        </p>
      ) : (
        <div data-testid="collections-list">
          {folders.length > 0 && (
            <ul className="api-collections" data-testid="collections-folders">
              {folders.map((f) => (
                <FolderRow
                  folder={f}
                  requests={collections.filter((c) => c.folderId === f.id)}
                  key={f.id}
                />
              ))}
            </ul>
          )}
          <ul
            className={`api-collections${rootDrop ? " api-collections--drop" : ""}`}
            data-testid="collections-root"
            onDragOver={onRootDragOver}
            onDragLeave={() => setRootDrop(false)}
            onDrop={onRootDrop}
          >
            {rootRequests.map((c) => (
              <RequestRow c={c} key={c.id} />
            ))}
            {rootRequests.length === 0 && folders.length > 0 && (
              <li className="api-folder__hint" data-testid="collections-root-hint">
                Drag a request here to move it back to the root.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
