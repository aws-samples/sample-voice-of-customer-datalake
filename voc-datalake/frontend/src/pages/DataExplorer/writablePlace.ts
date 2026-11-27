/**
 * @fileoverview Where the Data Explorer offers a write, as lambda/api/data_explorer_handler.py takes it.
 *
 * - In a workspace (the app sends its `X-Workspace-Id`), every key is relative to the workspace's own root and only
 *   `raw/` is written: any other prefix is a 400 read-only.
 * - In the deployment (no workspace), any key but the read-only prefixes (`_reject_read_only_prefix`: generated
 *   prototypes, the feedback history `silver/`, the engineering agents' `engineering/`).
 * - Either way an existing object under `raw/` is never overwritten (409): raw data is write-once.
 *
 * The API is the boundary; this only keeps the page from offering a write it would refuse.
 *
 * @module pages/DataExplorer/writablePlace
 */

/** Whose objects the explorer shows: the current workspace's, or the deployment's outside every workspace. */
export type ExplorerPlace = 'workspace' | 'deployment'

const RAW_PREFIX = 'raw/'
/** The deployment's read-only prefixes (data_explorer_handler.py `_reject_read_only_prefix`). */
const DEPLOYMENT_READ_ONLY_PREFIXES: readonly string[] = ['prototypes/', 'silver/', 'engineering/']

/** The place of the app's current workspace (`null`: in none). */
export function explorerPlace(workspace: Readonly<{ id: string }> | null): ExplorerPlace {
  return workspace === null ? 'deployment' : 'workspace'
}

/**
 * Whether the caller may use the explorer here: every /data-explorer/* route in a workspace is for its admins only
 * (403), a deployment admin's request included. `role` is the one the server applies in `workspace`
 * (workspace/useMyWorkspaces.ts `useServerRole`, null until `/me/workspaces/current` answers), never the membership
 * list's: a platform admin who is an editor there is the server's admin. `pending` until it is known; outside every
 * workspace `open` (the page sits under the deployment admins' route).
 */
export type ExplorerAccess = 'open' | 'pending' | 'refused'

export function explorerAccess(workspace: object | null, role: string | null): ExplorerAccess {
  if (workspace === null) return 'open'
  if (role === null) return 'pending'
  return role === 'admin' ? 'open' : 'refused'
}

/** Whether the API takes a new object at `key` in `place`. */
export function isWritableKey(key: string, place: ExplorerPlace): boolean {
  if (place === 'workspace') return key.startsWith(RAW_PREFIX)
  return !DEPLOYMENT_READ_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Whether the existing object at `key` may be edited (saved over) in `place`: never under `raw/`. */
export function canEditExisting(key: string, place: ExplorerPlace): boolean {
  return !key.startsWith(RAW_PREFIX) && isWritableKey(key, place)
}

/** Where a new file opened in the folder `path` goes: that folder when it is written to, else `raw/`. */
export function newFilePrefix(path: readonly string[], place: ExplorerPlace): string {
  if (path.length === 0) return RAW_PREFIX
  const folder = `${path.join('/')}/`
  return isWritableKey(folder, place) ? folder : RAW_PREFIX
}
