/**
 * @fileoverview Whose categories, dimensions and source profiles an editor works on (docs/multi-workspace.md → The
 * configuration cut-over, 7.08.00).
 *
 * - `'workspace'` (the default): the calls carry the current workspace's `X-Workspace-Id` (none outside one), so
 *   the workspace's settings page edits that workspace's own rows, for its admins.
 * - `'deployment'`: the calls never carry the header (api/baseUrl.ts `RequestScope`, as the platform console's
 *   deployment brand editor since 7.02.00), so Administration's editors edit the deployment's rows, which classify
 *   and redact all feedback outside workspaces, for the deployment's administrators, from any address.
 *
 * A deployment-scoped read is cached under its own key (`scopedKey`), which still starts with the shared one, so an
 * invalidation of the shared key reaches both.
 *
 * @module workspace/configScope
 */
import { createContext, useContext } from 'react'
import type { RequestScope } from '../api/baseUrl'

export const ConfigScopeContext = createContext<RequestScope>('workspace')

/** The scope the enclosing editor works on (`'workspace'` unless a section provides `'deployment'`). */
export function useConfigScope(): RequestScope {
  return useContext(ConfigScopeContext)
}

/** `key` for the workspace's rows; `key` plus a `'deployment'` part for the deployment's. */
export function scopedKey<K extends readonly unknown[]>(key: K, scope: RequestScope): readonly unknown[] {
  return scope === 'deployment' ? [...key, 'deployment'] : key
}
