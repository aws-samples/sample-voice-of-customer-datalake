/**
 * @fileoverview Agents → Skills (administrators, while the engineering agents are on): the engineering agents' skill
 * versions, read only. A scope (the shared skills every connection falls back to, or one repository connection's own)
 * lists its roles with a version (`GET /agents/engineering/skills`): the current version, how many were made and the
 * newest one's summary. A role opens its history (SkillHistory.tsx) and, on a connection, its scorecards
 * (SkillScorecards.tsx); a version opens its detail and its diff (SkillVersionDetail.tsx). The role and the version
 * are the path (`/agents/skills/<role>/v/<n>`, agentsPaths.ts) and the scope a filter of the query (`?connection=`),
 * so a view can be shared and Back returns from a version to the history, and from a role to the scope's roles.
 * A role whose bundled template is newer than its versions (its history says so) says **Template updated (vN)** on
 * its panel, with the template's diff and Adopt (SkillTemplateUpdate.tsx, 7.50.00): a person's proposal, never
 * automatic.
 *
 * @module pages/Agents/EngineeringSkills
 */
import { useId } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import { usePlaceNavigate } from '../../utils/pathPlace'
import { agentsPath, readAgentsAddress } from './agentsPaths'
import { skillsViewOf } from './skillsView'
import { SkillHistory, SkillStatusBadge } from './SkillHistory'
import { useSkillFormats } from './skillFormats'
import { SkillScorecards } from './SkillScorecards'
import { SkillVersionDetail } from './SkillVersionDetail'
import { SkillTemplateUpdate } from './SkillTemplateUpdate'
import type { SkillRole, SkillRoleLine } from '../../api/engineeringSkillsApi'
import type { SkillsView } from './skillsView'

function useConfigured() {
  return useConfigStore((s) => s.config.apiEndpoint) !== ''
}

/** The scopes to pick from: the shared skills, then each stored connection (and one the address names, kept). */
function ScopePicker({ connection, onChange }: Readonly<{ connection: string; onChange: (connection: string) => void }>) {
  const { t } = useTranslation('agents')
  const id = useId()
  const configured = useConfigured()
  const { data, isError } = useQuery({
    queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: configured,
  })
  const ids = (data?.connections ?? []).map((stored) => stored.connection_id)
  const offered = connection === '' || ids.includes(connection) ? ids : [connection, ...ids]
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{t('skills.scope')}</label>
      <select id={id} className="select w-auto" value={connection} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('skills.shared')}</option>
        {offered.map((name) => <option key={name} value={name}>{t('skills.connection', { name })}</option>)}
      </select>
      {isError && <p className="text-[12px] text-warn">{t('skills.connectionsFailed')}</p>}
    </div>
  )
}

function RolesTable({ roles, onOpen }: Readonly<{ roles: SkillRoleLine[]; onOpen: (role: SkillRole) => void }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const th = 'px-3 py-2 text-left text-[12px] font-semibold text-muted'
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[36rem]">
        <caption className="sr-only">{t('skills.rolesCaption')}</caption>
        <thead className="bg-bg-accent border-b border-border">
          <tr>
            <th scope="col" className={th}>{t('skills.columns.role')}</th>
            <th scope="col" className={th}>{t('skills.columns.current')}</th>
            <th scope="col" className={th}>{t('skills.columns.versions')}</th>
            <th scope="col" className={th}>{t('skills.columns.latest')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {roles.map((line) => (
            <tr key={line.role}>
              <th scope="row" className="px-3 py-2 text-left text-sm font-normal">
                <button type="button" className="link text-left" onClick={() => onOpen(line.role)}
                  aria-label={t('skills.openRole', { role: t(`skills.role.${line.role}`) })}>
                  {t(`skills.role.${line.role}`)}
                </button>
              </th>
              <td className="px-3 py-2 text-sm">
                {line.current_version === 0 ? <span className="text-muted">{t('skills.noneAccepted')}</span>
                  : t('skills.version', { version: line.current_version })}
              </td>
              <td className="px-3 py-2 text-sm font-mono">{line.versions}</td>
              <td className="px-3 py-2 text-sm">
                {line.latest !== null && (
                  <div className="space-y-1">
                    <SkillStatusBadge status={line.latest.status} current={line.latest.version === line.current_version} />
                    <p className="break-words [overflow-wrap:anywhere]">{line.latest.summary}</p>
                    <p className="text-[12px] text-muted">{format.at(line.latest.proposed_at)}</p>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScopeRoles({ connection, onOpen }: Readonly<{ connection: string; onOpen: (role: SkillRole) => void }>) {
  const { t } = useTranslation('agents')
  const configured = useConfigured()
  const read = useQuery({
    queryKey: engineeringSkillsKeys.roles(connection),
    queryFn: () => engineeringSkillsApi.roles(connection),
    enabled: configured,
    placeholderData: keepPreviousData,
  })
  return (
    <div aria-busy={read.isFetching} className="space-y-3">
      {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.loading')} />}
      {read.isError && <LoadFailed message={t('skills.rolesFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />}
      {read.data?.length === 0 && (
        <p className="card p-6 text-center text-sm text-muted">{connection === '' ? t('skills.emptyShared') : t('skills.emptyConnection')}</p>
      )}
      {read.data !== undefined && read.data.length > 0 && <RolesTable roles={read.data} onOpen={onOpen} />}
    </div>
  )
}

/** The role's line among a scope's roles, once read. */
const lineOf = (roles: readonly SkillRoleLine[] | undefined, role: SkillRole): SkillRoleLine | undefined =>
  roles?.find((entry) => entry.role === role)

/**
 * The role's current version in the scope, and the shared skill's (what a connection with no version of its own runs:
 * the approval card names it), from the scopes' roles.
 */
function useRoleHead(connection: string, role: SkillRole) {
  const configured = useConfigured()
  const roles = useQuery({
    queryKey: engineeringSkillsKeys.roles(connection), queryFn: () => engineeringSkillsApi.roles(connection), enabled: configured,
  })
  const shared = useQuery({
    queryKey: engineeringSkillsKeys.roles(''), queryFn: () => engineeringSkillsApi.roles(''), enabled: configured && connection !== '',
  })
  const line = lineOf(roles.data, role)
  const fallback = connection === '' ? undefined : lineOf(shared.data, role)
  return { current: line?.current_version ?? 0, fallback: fallback?.current_version ?? 0 }
}

function RolePanel({ view, role, onView }: Readonly<{ view: SkillsView; role: SkillRole; onView: (next: Partial<SkillsView>) => void }>) {
  const { t } = useTranslation('agents')
  const { connection, version } = view
  const { current, fallback } = useRoleHead(connection, role)
  return (
    <div className="space-y-4">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onView({ role: null, version: null })}>
        <ArrowLeft size={14} aria-hidden="true" /> {t('skills.backToRoles')}
      </button>
      <h2 className="text-lg font-semibold text-text-strong">
        {t('skills.roleTitle', { role: t(`skills.role.${role}`), scope: connection === '' ? t('skills.shared') : t('skills.connection', { name: connection }) })}
      </h2>
      <SkillTemplateUpdate key={`${connection}-${role}`} connection={connection} role={role}
        onOpen={(next) => onView({ version: next })} />
      {version === null
        ? <SkillHistory connection={connection} role={role} onOpen={(next) => onView({ version: next })} />
        : <SkillVersionDetail connection={connection} role={role} version={version} current={{ own: current, shared: fallback }}
          onBack={() => onView({ version: null })} />}
      <SkillScorecards key={`${connection}-${role}`} connection={connection} role={role} />
    </div>
  )
}

export function EngineeringSkills() {
  const { t } = useTranslation('agents')
  const location = useLocation()
  const read = readAgentsAddress(location)
  const search = read?.replaceWith?.search ?? location.search
  const view = skillsViewOf(read?.place ?? { role: null, version: null }, new URLSearchParams(search))
  const move = usePlaceNavigate()
  const change = (next: Partial<SkillsView>) => {
    const { connection, role, version } = { ...view, ...next }
    const params = new URLSearchParams(search)
    if (connection === '') params.delete('connection')
    else params.set('connection', connection)
    const query = params.toString()
    move({ pathname: agentsPath({ view: 'skills', role, version }), search: query === '' ? '' : `?${query}` })
  }
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted max-w-prose">{t('skills.hint')}</p>
      <ScopePicker connection={view.connection} onChange={(connection) => change({ connection, role: null, version: null })} />
      {view.role === null
        ? <ScopeRoles connection={view.connection} onOpen={(role) => change({ role, version: null })} />
        : <RolePanel view={view} role={view.role} onView={change} />}
    </section>
  )
}
