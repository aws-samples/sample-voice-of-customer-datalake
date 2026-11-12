/**
 * @fileoverview What the workspace gate shows, from the address and the caller's workspaces
 * (docs/multi-workspace.md, Request flow step 1). Pure, so every case is a unit test.
 *
 * | Address        | Workspaces               | Shows                                                         |
 * |----------------|--------------------------|---------------------------------------------------------------|
 * | `/w/{slug}/…`  | the slug is one          | the app in that workspace                                     |
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
 * @module workspace/gateDecision
 */
import { workspaceUrl } from './workspacePath'
import type { CurrentWorkspace } from './currentWorkspace'
import type { PathWorkspace } from './workspacePath'

export type GateDecision =
  | { readonly kind: 'without-workspace' }
  | { readonly kind: 'enter'; readonly workspace: CurrentWorkspace }
  | { readonly kind: 'redirect'; readonly to: string }
  /** `path`: the address asked for, which each choice opens inside its workspace (like the redirect). */
  | { readonly kind: 'pick'; readonly workspaces: readonly CurrentWorkspace[]; readonly path: string }
  | { readonly kind: 'not-found'; readonly workspaces: readonly CurrentWorkspace[] }
  | { readonly kind: 'unavailable' }

/**
 * `workspaces` is the caller's list, or null when it could not be read (no data at all: a list read once keeps
 * counting while a later refetch fails). `routerPath` is the path, query and hash the router sees, kept by the
 * one-workspace redirect and the picker.
 */
export function gateDecision(path: PathWorkspace, workspaces: readonly CurrentWorkspace[] | null, routerPath: string): GateDecision {
  if (workspaces === null) return path.kind === 'none' ? { kind: 'without-workspace' } : { kind: 'unavailable' }
  if (path.kind === 'invalid') return { kind: 'not-found', workspaces }
  if (path.kind === 'slug') {
    const workspace = workspaces.find((candidate) => candidate.slug === path.slug)
    return workspace === undefined ? { kind: 'not-found', workspaces } : { kind: 'enter', workspace }
  }
  const [only, ...others] = workspaces
  if (only === undefined) return { kind: 'without-workspace' }
  if (others.length === 0) return { kind: 'redirect', to: workspaceUrl(only.slug, routerPath) }
  return { kind: 'pick', workspaces, path: routerPath }
}
