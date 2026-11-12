/**
 * @fileoverview A platform admin's entry into a workspace from the platform console (sessionStorage).
 *
 * `GET /me/workspaces` lists only the caller's memberships, so a `/w/{slug}` address of a workspace a platform admin
 * is not a member of has no id for the gate to send. Before its full page load, the console's Enter records the
 * workspace it chose (id and slug); on that address the gate then asks `GET /me/workspaces/current` with this id
 * and opens the workspace only when the server answers it, with the same slug (decision 2: the server lets a
 * live-checked platform admin in as admin and audits the entry). Anyone else gets the server's one 404 and the same
 * not-found page as for any slug that is not theirs: the record only names an id to ask about, it grants nothing.
 *
 * It lasts for the tab (a reload, or signing back in after an expired session, keeps the workspace open), is dropped
 * when the server refuses it, and is cleared at sign-out. It imports nothing of the app, like refusedWorkspaces.ts.
 *
 * @module workspace/platformEntry
 */
import { z } from 'zod'

const PLATFORM_ENTRIES_KEY = 'voc-platform-entries'

// No name: nothing of the workspace renders before the server answers, and its answer names it.
const EntrySchema = z.object({ id: z.string().min(1), slug: z.string().min(1) })
export type PlatformEntry = z.infer<typeof EntrySchema>

function storedEntries(): PlatformEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(PLATFORM_ENTRIES_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((row: unknown) => {
      const entry = EntrySchema.safeParse(row)
      return entry.success ? [entry.data] : []
    })
  } catch {
    // Storage blocked or a value this build cannot read: no entry.
    return []
  }
}

function store(entries: readonly PlatformEntry[]): void {
  try {
    window.sessionStorage.setItem(PLATFORM_ENTRIES_KEY, JSON.stringify(entries))
  } catch {
    // Storage blocked: the gate answers not-found for a workspace the caller is not a member of.
  }
}

/** The entry the console recorded for `slug` in this tab, or null. */
export function platformEntryFor(slug: string): PlatformEntry | null {
  return storedEntries().find((entry) => entry.slug === slug) ?? null
}

/** Record `entry` (replacing one for the same slug) before the console's full page load into it. */
export function rememberPlatformEntry(entry: PlatformEntry): void {
  store([...storedEntries().filter((stored) => stored.slug !== entry.slug), { id: entry.id, slug: entry.slug }])
}

/** Drop the entry for `slug` (the server refused it). */
export function forgetPlatformEntry(slug: string): void {
  store(storedEntries().filter((entry) => entry.slug !== slug))
}

/** Drop every entry of the tab (sign-out; an expired session keeps them, services/sessionExpiry.ts). */
export function forgetPlatformEntries(): void {
  try {
    window.sessionStorage.removeItem(PLATFORM_ENTRIES_KEY)
  } catch {
    // Storage blocked: there is nothing stored to forget.
  }
}
