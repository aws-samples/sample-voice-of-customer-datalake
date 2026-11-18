/**
 * @fileoverview What a scope runs of a role, as Agents → Skills reads it: its own current version, the shared skill's
 * (what a connection with none of its own runs), and so the version in use (skillActionRules.ts `inUse`), with its
 * whole record once asked for (the base a person's own version is written on, gap M).
 *
 * @module pages/Agents/useSkillInUse
 */
import { useQuery } from '@tanstack/react-query'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import type { SkillRole, SkillRoleLine } from '../../api/engineeringSkillsApi'
import type { ActionTarget } from './SkillActionParts'

/** The role's line among a scope's roles, once read. */
const lineOf = (roles: readonly SkillRoleLine[] | undefined, role: SkillRole): SkillRoleLine | undefined =>
  roles?.find((entry) => entry.role === role)

/** A version of a role in a scope: the scope it is read from (`''`: the shared skills) and its number. */
export interface ScopedSkillVersion { readonly scope: string; readonly version: number }

export function useSkillHead(connection: string, role: SkillRole) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const roles = useQuery({
    queryKey: engineeringSkillsKeys.roles(connection), queryFn: () => engineeringSkillsApi.roles(connection), enabled: configured,
  })
  const shared = useQuery({
    queryKey: engineeringSkillsKeys.roles(''), queryFn: () => engineeringSkillsApi.roles(''), enabled: configured && connection !== '',
  })
  const current = lineOf(roles.data, role)?.current_version ?? 0
  const fallback = connection === '' ? 0 : lineOf(shared.data, role)?.current_version ?? 0
  const known = roles.isSuccess && (connection === '' || shared.isSuccess)
  return { current, fallback, inUse: inUseOf(connection, current, fallback), known }
}

/** The version a scope runs: its own current one, else (a connection) the shared skill's; null for none. */
function inUseOf(connection: string, current: number, fallback: number): ScopedSkillVersion | null {
  if (current !== 0) return { scope: connection, version: current }
  return fallback === 0 ? null : { scope: '', version: fallback }
}

/** The whole record of a version of a role (the version in use, a base), read once `version` is known. */
export function useSkillVersion(version: ScopedSkillVersion | null, role: SkillRole) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({
    queryKey: engineeringSkillsKeys.version(version?.scope ?? '', role, version?.version ?? 0),
    queryFn: () => engineeringSkillsApi.version(version?.scope ?? '', role, version?.version ?? 0),
    enabled: configured && version !== null,
  })
}

/**
 * A version of a role's skill in a scope, read (its page's and its sheet's), and what its actions act on once it is:
 * `current`, the scope's own current version and the shared skill's (null: not read yet).
 */
export function useSkillVersionTarget(connection: string, role: SkillRole, version: number,
  current: Readonly<{ own: number; shared: number }>) {
  const read = useSkillVersion({ scope: connection, version }, role)
  const target: ActionTarget | null = read.data === undefined ? null
    : { connection, role, detail: read.data, current: current.own, sharedCurrent: current.shared }
  return { read, target }
}
