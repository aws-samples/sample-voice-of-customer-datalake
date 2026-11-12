/**
 * @fileoverview What the workspace gate shows, from the address and the caller's workspaces
 * (docs/multi-workspace.md, Request flow step 1). Pure, so every case is a unit test.
 *
 * | Address        | Workspaces               | Shows                                                         |
 * |----------------|--------------------------|---------------------------------------------------------------|
 * | `/w/{slug}/…`  | the slug is one          | the app in that workspace                                     |
 * | `/w/{slug}/…`  | the slug is none, but the platform console entered it in this tab | that workspace, once the server confirms it |
 * | `/w/{slug}/…`  | the slug is none         | "not found, or not a member", with the caller's own as links  |
 * | `/w/…`         | the list failed          | "could not load your workspaces", with Retry and Sign out     |
 * | no `/w/`       | exactly one              | a full page load to the same path inside it                   |
 * | no `/w/`       | two or more              | the picker; each choice opens the same path inside it         |
 * | no `/w/`       | none, or the list failed | the app as before workspaces (no workspace, no header)        |
 *
 * The not-found answer is the same whether the slug exists or not: the list holds only the caller's own, so
 * nothing here can confirm another team's workspace. An address inside a workspace never opens the app without
 * one: its pages would read and write outside the workspace the address names.
 *
 * A platform admin entering a workspace they are not a member of (the console's Enter, `platformEntry.ts`) is the
 * one slug outside the list: `enter-unlisted` names the id the console recorded, and the gate opens nothing until
 * `GET /me/workspaces/current` answers that workspace with that slug; the server's 404 shows the same not-found page
 * as for any other slug, so the record lets no one else in and confirms nothing.
 *
 * @module workspace/gateDecision
 */
import { workspaceUrl } from './workspacePath'
import type { CurrentWorkspace } from './currentWorkspace'
import type { PlatformEntry } from './platformEntry'
import type { PathWorkspace } from './workspacePath'

export type GateDecision =
  | { readonly kind: 'without-workspace' }
  | { readonly kind: 'enter'; readonly workspace: CurrentWorkspace }
  /** A slug outside the caller's list that the platform console entered: opened only once the server confirms it. */
  | { readonly kind: 'enter-unlisted'; readonly workspace: CurrentWorkspace }
  | { readonly kind: 'redirect'; readonly to: string }
  /** `path`: the address asked for, which each choice opens inside its workspace (like the redirect). */
  | { readonly kind: 'pick'; readonly workspaces: readonly CurrentWorkspace[]; readonly path: string }
  | { readonly kind: 'not-found'; readonly workspaces: readonly CurrentWorkspace[] }
  | { readonly kind: 'unavailable' }

/**
 * `workspaces` is the caller's list, or null when it could not be read (no data at all: a list read once keeps
 * counting while a later refetch fails). `routerPath` is the path, query and hash the router sees, kept by the
 * one-workspace redirect and the picker. `entry` is the platform console's record for the address's slug, if any.
 */
export function gateDecision(
  path: PathWorkspace, workspaces: readonly CurrentWorkspace[] | null, routerPath: string, entry: PlatformEntry | null = null,
): GateDecision {
  if (workspaces === null) return path.kind === 'none' ? { kind: 'without-workspace' } : { kind: 'unavailable' }
  if (path.kind === 'invalid') return { kind: 'not-found', workspaces }
  if (path.kind === 'slug') {
    const workspace = workspaces.find((candidate) => candidate.slug === path.slug)
    if (workspace !== undefined) return { kind: 'enter', workspace }
    // The role is the server's to say: nothing renders before `/current` answers (WorkspaceGate).
    // No name either: nothing renders before the server's answer, which names the workspace (WorkspaceGate).
    if (entry?.slug === path.slug) return { kind: 'enter-unlisted', workspace: { id: entry.id, slug: entry.slug, name: '', role: 'admin' } }
    return { kind: 'not-found', workspaces }
  }
  const [only, ...others] = workspaces
  if (only === undefined) return { kind: 'without-workspace' }
  if (others.length === 0) return { kind: 'redirect', to: workspaceUrl(only.slug, routerPath) }
  return { kind: 'pick', workspaces, path: routerPath }
}
