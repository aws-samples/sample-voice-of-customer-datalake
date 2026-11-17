/**
 * @fileoverview Agents → Connections' status line (7.52.00, ux-agents-redesign part 1 §2.6): one chip, "Connected" or
 * "Needs attention" (a row or an App has an action waiting: connectionStatus.ts), then what is connected in plain words:
 * "2 repositories through voc-agents-ac7a4f · 1 needs its CI attested · Issues read automatically". The last part only
 * while the deployment's GitHub Issues source reads a repository (S4). Numbers in the body font (`tabular-nums`).
 *
 * @module pages/Agents/ConnectionsStatus
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleCheck } from 'lucide-react'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import type { ConnectionsSummary } from './connectionStatus'

export function ConnectionsStatus({ summary }: Readonly<{ summary: ConnectionsSummary }>) {
  const { t } = useTranslation('agents')
  if (summary.empty) return null
  const parts = [
    ...summary.through.map(({ slug, count }) => t('connections.summary.through', { count, slug })),
    ...(summary.others > 0 ? [t('connections.summary.others', { count: summary.others })] : []),
    ...(summary.ciNeeded > 0 ? [t('connections.summary.ciNeeded', { count: summary.ciNeeded })] : []),
    ...(summary.issuesRead ? [t('connections.summary.issuesRead')] : []),
  ]
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted tabular-nums" data-testid="connections-status">
      {summary.attention
        ? <IconBadge toneClass="badge-warn" icon={AlertTriangle}>{t('connections.summary.attention')}</IconBadge>
        : <IconBadge toneClass="badge-ok" icon={CircleCheck}>{t('connections.summary.connected')}</IconBadge>}
      {parts.length > 0 && <span className="text-text">{parts.join(' · ')}</span>}
    </p>
  )
}
