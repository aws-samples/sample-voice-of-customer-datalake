/**
 * @fileoverview "Needs you" (7.52.00 C1; ux-agents-redesign part 4 §4.4), above the Automations list: the daily job
 * first. One line per thing waiting for a person: an automation whose last run needs a decision (Review opens its
 * runs), and the skill versions waiting for review (Review opens Skills). Hidden when nothing waits, and for a person
 * who is not an administrator (they decide nothing here).
 *
 * @module pages/Agents/Automations/NeedsYou
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Hand } from 'lucide-react'
import { IconBadge } from '../../../components/IconBadge/IconBadge'
import { formatRelativeDate } from '../../../utils/dateUtils'
import { agentPath, agentsPath } from '../agentsPaths'
import { useSkillsToReview } from '../orchestrationCounts'
import type { ReactNode } from 'react'
import type { Agent } from '../../../api/agentsApi'

function NeedsYouRow({ badge, text, to, reviewLabel }: Readonly<{ badge: ReactNode; text: string; to: string; reviewLabel: string }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      {badge}
      <span className="min-w-0 flex-1 text-sm text-text break-words [overflow-wrap:anywhere]">{text}</span>
      <Link to={to} className="btn btn-secondary btn-sm">
        {t('automations.needsYou.review')}{' '}<span className="sr-only">{reviewLabel}</span>
      </Link>
    </li>
  )
}

export function NeedsYou({ agents, isAdmin }: Readonly<{ agents: readonly Agent[]; isAdmin: boolean }>) {
  const { t, i18n } = useTranslation('agents')
  const titleId = useId()
  const skills = useSkillsToReview(isAdmin)
  const deciding = agents.filter((agent) => agent.stats.last_run_status === 'needs_human')
  const toReview = skills?.length ?? 0
  const count = deciding.length + (toReview > 0 ? 1 : 0)
  if (!isAdmin || count === 0) return null
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">
        {t('automations.needsYou.title', { count })}
      </h2>
      <ul role="list" className="card p-0 overflow-hidden divide-y divide-border">
        {deciding.map((agent) => (
          <NeedsYouRow key={agent.agent_id} to={agentPath(agent.agent_id, 'runs')} reviewLabel={agent.name}
            badge={<IconBadge toneClass="badge-warn" icon={Hand}>{t('automations.needsYou.decision')}</IconBadge>}
            text={t('automations.needsYou.decisionLine', { name: agent.name, when: formatRelativeDate(agent.stats.last_run_at, i18n.language) })} />
        ))}
        {toReview > 0 && (
          <NeedsYouRow to={agentsPath({ view: 'skills' })} reviewLabel={t('shell.tabs.skills')}
            badge={<IconBadge toneClass="badge-warn" icon={AlertTriangle}>{t('automations.needsYou.waiting')}</IconBadge>}
            text={t('automations.needsYou.skillsLine', { count: toReview })} />
        )}
      </ul>
    </section>
  )
}
