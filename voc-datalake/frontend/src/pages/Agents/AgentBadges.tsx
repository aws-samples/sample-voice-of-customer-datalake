/**
 * @fileoverview Small shared displays of the agents pages: a run's status as a
 * toned badge, and an agent's scope in one line (categories by their display
 * labels, never their ids).
 *
 * @module pages/Agents/AgentBadges
 */
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { AgentScope, RunStatus } from '../../api/agentsApi'

const RUN_TONE: Readonly<Record<RunStatus, string>> = {
  queued: 'badge-muted',
  running: 'badge-accent',
  needs_human: 'badge-warn',
  completed: 'badge-ok',
  failed: 'badge-danger',
  cancelled: 'badge-muted',
}

export function RunStatusBadge({ status }: Readonly<{ status: RunStatus }>) {
  const { t } = useTranslation('agents')
  return <span className={`badge ${RUN_TONE[status]}`}>{t(`run.status.${status}`)}</span>
}

export function ScopeSummary({ scope }: Readonly<{ scope: AgentScope }>) {
  const { t } = useTranslation('agents')
  const labels = useDisplayLabels()
  if (scope.all) return <>{t('scope.all')}</>
  const names = [...scope.categories.map(labels.category), ...scope.subcategories.map((s) => labels.theme(s.category, s.name))]
  return <>{t('scope.some', { list: names.join(', ') })}</>
}
