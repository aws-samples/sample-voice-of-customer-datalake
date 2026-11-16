/**
 * @fileoverview Agents → Skills, the view's rules (EngineeringSkills.tsx): what the address says is open (the role
 * and the version are the path, `/agents/skills/<role>/v/<n>`, agentsPaths.ts; the scope is a filter of the query,
 * `?connection=`), a status's badge, and the versions a person types to compare (1 to 10 whole numbers, each once).
 *
 * @module pages/Agents/skillsView
 */
import { MAX_COMPARED, isSkillRole } from '../../api/engineeringSkillsApi'
import type { SkillDiff, SkillRole } from '../../api/engineeringSkillsApi'
import type { AgentsPlace } from './agentsPaths'

/** A diff that changes nothing (an administrator's version written again as it was). */
export function diffIsEmpty(diff: SkillDiff): boolean {
  const parts = [diff.instructions, diff.examples, diff.tools_added, diff.tools_removed]
  return parts.every((part) => part.length === 0) && !diff.tools_reordered && diff.model === null && diff.harness === null
}

export interface SkillsView {
  /** '' for the shared skills, else a connection's id. */
  connection: string
  role: SkillRole | null
  /** A version of the role, opened (null: the history). */
  version: number | null
}

const VERSION = /^[1-9]\d{0,5}$/u

/**
 * The view the address names (its path's role and version, its query's scope); a role the engineering agents do not
 * have is left out (the scope's roles), and its version with it.
 */
export function skillsViewOf(place: Pick<AgentsPlace, 'role' | 'version'>, params: URLSearchParams): SkillsView {
  const role = place.role ?? ''
  const known = isSkillRole(role) ? role : null
  return { connection: params.get('connection') ?? '', role: known, version: known === null ? null : place.version }
}

/** A version's status as a badge's class (an unknown one reads as muted). */
export function statusTone(status: string): string {
  switch (status) {
    case 'accepted': return 'badge badge-ok'
    case 'proposed': return 'badge badge-warn'
    case 'rejected': return 'badge badge-danger'
    default: return 'badge badge-muted'
  }
}

export type VersionsInput =
  | { ok: true; versions: number[] }
  | { ok: false; reason: 'empty' | 'notNumbers' | 'tooMany' | 'repeated' }

/** "3, 2, 1" as the versions to compare: whole numbers from 1, at most `MAX_COMPARED`, each once. */
export function parseVersionsInput(raw: string): VersionsInput {
  const parts = raw.split(/[\s,]+/u).filter((part) => part !== '')
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  if (!parts.every((part) => VERSION.test(part))) return { ok: false, reason: 'notNumbers' }
  if (parts.length > MAX_COMPARED) return { ok: false, reason: 'tooMany' }
  const versions = parts.map(Number)
  if (new Set(versions).size !== versions.length) return { ok: false, reason: 'repeated' }
  return { ok: true, versions }
}
