/**
 * @fileoverview Agents → Skills (administrators, while the engineering agents are on): the engineering agents' skill
 * versions. A scope (the shared skills every connection falls back to, or one repository connection's own, named by
 * its repository) lists its roles (SkillRolesTable.tsx: what waits for review first, the current version, a newer
 * template in `badge-info`, the last change). A role opens its history (SkillHistory.tsx) and, on a connection, its
 * scorecards (SkillScorecards.tsx); a version from the history opens beside it as a sheet (SkillVersionSheet.tsx) with
 * Open full page, its own page (SkillVersionDetail.tsx): the version read on the shared document component, a
 * proposal as its changes with Accept the one primary. **Propose a version** (gap M) writes one's own on the version
 * in use (SkillProposeSheet.tsx): a proposal, never applied by itself; once sent, its review opens. A role whose
 * template is newer says so and compares it (SkillTemplateUpdate.tsx, "Propose v4 from the template").
 *
 * The role and the version are the path (`/agents/skills/<role>/versions/<n>`, agentsPaths.ts) and the scope a filter
 * of the query (`?connection=`), so a view can be shared and Back returns from a version to the history, and from a
 * role to the scope's roles. The sheets are this page's, over the history.
 *
 * Beside the roles, the **Library** (7.56.00, `/agents/skills/library`, SkillLibrary.tsx): the default skills the
 * release ships for the roles to read, the same in every scope, so it has no scope picker.
 *
 * @module pages/Agents/EngineeringSkills
 */
import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, PenLine } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import { usePlaceNavigate } from '../../utils/pathPlace'
import PressedChoices from '../../components/PressedChoices/PressedChoices'
import { agentsPath, readAgentsAddress } from './agentsPaths'
import { libraryPath, readLibraryPlace } from './skillLibraryPaths'
import { SkillLibrary } from './SkillLibrary'
import { skillsViewOf } from './skillsView'
import { ScopePicker } from './ScopePicker'
import { SkillHistory } from './SkillHistory'
import { SkillProposeSheet } from './SkillProposeSheet'
import { SkillRolesTable } from './SkillRolesTable'
import { SkillScorecards } from './SkillScorecards'
import { SkillVersionDetail } from './SkillVersionDetail'
import { SkillVersionSheet } from './SkillVersionSheet'
import { SkillTemplateUpdate } from './SkillTemplateUpdate'
import { useSkillHead } from './useSkillInUse'
import type { SkillRole } from '../../api/engineeringSkillsApi'
import type { SkillsView } from './skillsView'

function useConfigured() {
  return useConfigStore((s) => s.config.apiEndpoint) !== ''
}

function ScopeRoles({ connection, onOpen, onReview }: Readonly<{
  connection: string; onOpen: (role: SkillRole) => void; onReview: (role: SkillRole, version: number) => void
}>) {
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
      {read.data !== undefined && read.data.length > 0 && (
        <SkillRolesTable connection={connection} roles={read.data} onOpen={onOpen} onReview={onReview} />
      )}
    </div>
  )
}

/** What the role's page has open over it: a version from the history, or the Propose sheet. */
type Sheet = { readonly kind: 'version'; readonly version: number } | { readonly kind: 'propose' } | null

function RolePanel({ view, role, onView }: Readonly<{ view: SkillsView; role: SkillRole; onView: (next: Partial<SkillsView>) => void }>) {
  const { t } = useTranslation('agents')
  const { connection, version } = view
  const { current, fallback, inUse } = useSkillHead(connection, role)
  const [sheet, setSheet] = useState<Sheet>(null)
  const head = { own: current, shared: fallback }
  const propose = inUse === null ? null : () => setSheet({ kind: 'propose' })
  const openProposal = (proposed: number) => setSheet({ kind: 'version', version: proposed })
  return (
    <div className="space-y-4">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onView({ role: null, version: null })}>
        <ArrowLeft size={14} aria-hidden="true" /> {t('skills.backToRoles')}
      </button>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-lg font-semibold text-text-strong">
          {t('skills.roleTitle', { role: t(`skills.role.${role}`), scope: connection === '' ? t('skills.shared') : t('skills.connection', { name: connection }) })}
        </h2>
        {propose !== null && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={propose}>
            <PenLine size={14} aria-hidden="true" />{t('skills.propose.button')}
          </button>
        )}
      </div>
      <SkillTemplateUpdate key={`${connection}-${role}`} connection={connection} role={role} onOpen={openProposal} />
      {version === null
        ? <SkillHistory connection={connection} role={role} onOpen={(next) => setSheet({ kind: 'version', version: next })} />
        : <SkillVersionDetail connection={connection} role={role} version={version} current={head} onPropose={propose}
          onBack={() => onView({ version: null })} />}
      <SkillScorecards key={`${connection}-${role}`} connection={connection} role={role} />
      {sheet?.kind === 'version' && (
        <SkillVersionSheet key={sheet.version} connection={connection} role={role} version={sheet.version} current={head}
          onClose={() => setSheet(null)} onPropose={propose} />
      )}
      {sheet?.kind === 'propose' && (
        <SkillProposeSheet connection={connection} role={role} onClose={() => setSheet(null)} onProposed={openProposal} />
      )}
    </div>
  )
}

/** The tab's two views: the scope's roles, or the library. */
type SkillsPart = 'roles' | 'library'
const PARTS: readonly SkillsPart[] = ['roles', 'library']

export function EngineeringSkills() {
  const { t } = useTranslation('agents')
  const location = useLocation()
  const read = readAgentsAddress(location)
  const search = read?.replaceWith?.search ?? location.search
  const library = readLibraryPlace(location.pathname)
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
  const show = (part: SkillsPart) => {
    if (part === 'library') move({ pathname: libraryPath(), search: '' })
    else change({ role: null, version: null })
  }
  return (
    <section className="space-y-4">
      <PressedChoices label={t('skills.library.views')} choices={PARTS} value={library === null ? 'roles' : 'library'}
        onChange={show} display={(part) => t(`skills.library.view.${part}`)} className="tabs-track w-fit"
        pressedClassName="tab tab-active" idleClassName="tab" />
      {library !== null ? <SkillLibrary place={library} /> : (
        <>
          <p className="text-sm text-muted max-w-prose">{t('skills.hint')}</p>
          <ScopePicker connection={view.connection} label={t('skills.scope')} sharedLabel={t('skills.shared')}
            onChange={(connection) => change({ connection, role: null, version: null })} />
          {view.role === null
            ? <ScopeRoles connection={view.connection} onOpen={(role) => change({ role, version: null })}
              onReview={(role, version) => change({ role, version })} />
            : <RolePanel key={`${view.connection}-${view.role}`} view={view} role={view.role} onView={change} />}
        </>
      )}
    </section>
  )
}
