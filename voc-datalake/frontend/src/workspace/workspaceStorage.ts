/**
 * @fileoverview The browser-saved state of a workspace (docs/multi-workspace.md, Phases): the name a persisted
 * store saves under in this page load, and forgetting every workspace's records.
 *
 * Inside a workspace a store's record is its own, `<name>:w/{slug}` (`voc-assistant-ui:w/acme`), so a draft, a
 * filter or the conversation in view saved in one workspace never opens in another, and is back on return. Outside
 * one (no `/w/` in the address, a deployment without workspaces) the name is unchanged, so nothing changes there.
 *
 * The slug, not the id: the stores hydrate when their modules load, before the gate has read the caller's
 * workspaces, and the address is all that is known then. A slug is unique and fixed when the workspace is made
 * (decision 15), and switching workspaces is a full page load (workspacePath.ts), so a page load's stores belong
 * to one workspace for as long as they live. A `/w/…` address no workspace can have keeps the plain name: the gate
 * shows not-found there and opens no page.
 *
 * A page load holds only its own workspace's stores, so sign-out and an expired session drop the other
 * workspaces' records from the browser here ({@link forgetWorkspaceStores}).
 *
 * @module workspace/workspaceStorage
 */
import { PAGE_WORKSPACE } from './workspacePath'

/** The persisted stores saved per workspace (assistant/store/assistantStore.ts, store/manualImportStore.ts, store/configStore.ts). */
const WORKSPACE_STORES = ['voc-assistant-ui', 'voc-manual-import', 'voc-config'] as const
type WorkspaceStore = (typeof WORKSPACE_STORES)[number]

/** The persisted store `name` as this page load saves it: per workspace inside one, else `name` itself. */
export function workspaceStorageName(name: WorkspaceStore): string {
  return PAGE_WORKSPACE.kind === 'slug' ? `${name}:w/${PAGE_WORKSPACE.slug}` : name
}

/** Whether `key` is a workspace's own record of the store `name` (`voc-config:w/acme`). */
const isWorkspaceRecord = (name: string, key: string) => key.startsWith(`${name}:w/`)

/** Remove every key of `storage` that `matches`; a storage that is blocked holds nothing to remove. */
function removeMatching(storage: () => Storage, matches: (key: string) => boolean): void {
  try {
    const store = storage()
    const keys = Array.from({ length: store.length }, (_, index) => store.key(index))
    for (const key of keys) if (key !== null && matches(key)) store.removeItem(key)
  } catch {
    // Storage blocked (a privacy mode): nothing was saved there.
  }
}

const BROWSER_STORAGES: ReadonlyArray<() => Storage> = [() => window.localStorage, () => window.sessionStorage]

/**
 * Forget every workspace's record of the three stores, in localStorage and sessionStorage (sign-out, an expired
 * session): the next person on this browser finds no workspace's conversation in view, draft or filters. The
 * assistant's deployment-wide record goes too: before 6.15.00 the session's end reset it, and inside a workspace that
 * reset now writes the workspace's record instead. The plain draft and filters keep their old handling (kept).
 */
export function forgetWorkspaceStores(): void {
  for (const storage of BROWSER_STORAGES) {
    removeMatching(storage, (key) => key === ASSISTANT_STORE
      || WORKSPACE_STORES.some((name) => isWorkspaceRecord(name, key)))
  }
}

const ASSISTANT_STORE: WorkspaceStore = 'voc-assistant-ui'

/**
 * Forget every record of the store `name` but this page load's own (the plain one and every workspace's): "Reset
 * local settings" resets this browser's config, in every workspace, not only the one in view.
 */
export function forgetOtherRecords(name: WorkspaceStore): void {
  const own = workspaceStorageName(name)
  for (const storage of BROWSER_STORAGES) {
    removeMatching(storage, (key) => key !== own && (key === name || isWorkspaceRecord(name, key)))
  }
}
