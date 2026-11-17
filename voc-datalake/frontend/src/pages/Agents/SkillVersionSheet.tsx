/**
 * @fileoverview Agents → Skills → a version opened from the history, as a sheet beside it (§6.4 [52] step 1: the
 * document component's sheet, on the app's one side sheet, SideSheet `size="wide"`): its title, its status and who
 * wrote it as the sheet's description, the version's body (SkillVersionDetail.tsx `SkillVersionBody`, the inline
 * surface), and its actions in the sheet's footer with **Open full page** (`/agents/skills/<role>/versions/<n>`).
 * Escape closes it; an approval card opened from its footer stacks above it.
 *
 * @module pages/Agents/SkillVersionSheet
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import SideSheet from '../../components/SideSheet/SideSheet'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import { agentsPath } from './agentsPaths'
import { SkillProvenance, SkillVersionActions, SkillVersionBody } from './SkillVersionDetail'
import { useSkillTitle } from './skillFormats'
import type { ActionTarget } from './SkillActionParts'
import type { SkillRole } from '../../api/engineeringSkillsApi'

interface SheetProps {
  readonly connection: string
  readonly role: SkillRole
  readonly version: number
  /** The scope's own current version, and the shared skill's. */
  readonly current: Readonly<{ own: number; shared: number }>
  readonly onClose: () => void
  /** Open the Propose sheet on the version in use (null: not offered). */
  readonly onPropose: (() => void) | null
}

/** The version's own page, the scope kept in the query. */
const fullPathOf = (connection: string, role: SkillRole, version: number) => {
  const path = agentsPath({ view: 'skills', role, version })
  return connection === '' ? path : `${path}?${new URLSearchParams({ connection }).toString()}`
}

export function SkillVersionSheet({ connection, role, version, current, onClose, onPropose }: SheetProps) {
  const { t } = useTranslation('agents')
  const { t: td } = useTranslation('documents')
  const title = useSkillTitle()
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({
    queryKey: engineeringSkillsKeys.version(connection, role, version),
    queryFn: () => engineeringSkillsApi.version(connection, role, version),
    enabled: configured,
  })
  const target: ActionTarget | null = read.data === undefined ? null
    : { connection, role, detail: read.data, current: current.own, sharedCurrent: current.shared }
  const footer = (
    <>
      <Link to={fullPathOf(connection, role, version)} className="btn btn-ghost btn-sm">
        {td('panel.openFull')}<ExternalLink size={12} aria-hidden="true" />
      </Link>
      {target !== null && <SkillVersionActions target={target} onPropose={onPropose} />}
    </>
  )
  return (
    <SideSheet isOpen onClose={onClose} size="wide" title={title(role, version)} footer={footer}
      description={target === null ? undefined : <SkillProvenance detail={target.detail} current={target.detail.version === target.current} />}>
      <div aria-busy={read.isFetching}>
        {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.loading')} />}
        {read.isError && <LoadFailed message={t('skills.versionFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />}
        {target !== null && <SkillVersionBody target={target} variant="inline" />}
      </div>
    </SideSheet>
  )
}
