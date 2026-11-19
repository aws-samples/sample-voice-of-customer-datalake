/**
 * @fileoverview The inspector's Cost tab (7.51.00): what the open agent used (its cost at its tokens' prices, its
 * model with its harness (7.58.00), skill, attempt and commit), its session as the supervisor keeps it (step, MicroVM, heartbeat, last progress,
 * start, MicroVM time and tokens per model: the run monitor's agent card), and every agent of the run beside it,
 * costliest first, from the overview.
 *
 * @module pages/Agents/RunWorkspace/CostTab
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { AgentFacts } from '../EngineeringRunPanels'
import { useModelChoiceText } from '../modelChoiceText'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

function useCostText(): (value: number | null) => string {
  const { i18n } = useTranslation()
  const format = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return (value) => (value === null ? '—' : format.format(value))
}

/** (7.58.00) Its model in words and harness, then the id its launch asked for ("Opus 5.5 · Kiro (claude-opus-5.5)"). */
function modelFact(said: string | null, agent: EngineeringAgent): string {
  return said === null || agent.model === null ? '—' : `${said} (${agent.model})`
}

function AgentUse({ agent, readAt }: Readonly<{ agent: EngineeringAgent; readAt: number }>) {
  const { t } = useTranslation('agents')
  const usd = useCostText()
  const model = useModelChoiceText()
  const facts: [string, string][] = [
    [t('runWorkspace.cost.cost'), usd(agent.cost_usd)],
    [t('runWorkspace.cost.model'), modelFact(model.agent(agent), agent)],
    [t('runWorkspace.cost.skill'), agent.skill_label ?? '—'],
    [t('runWorkspace.cost.attempt'), String(agent.attempt)],
    [t('runWorkspace.cost.commit'), agent.commit === null ? '—' : agent.commit.slice(0, 12)],
  ]
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]">
        {facts.map(([name, value]) => <div key={name} className="contents"><dt className="text-muted">{name}</dt><dd className="break-all">{value}</dd></div>)}
      </dl>
      <AgentFacts agent={agent} now={readAt} />
    </div>
  )
}

export function CostTab({ agent, agents, readAt }: Readonly<{ agent: EngineeringAgent; agents: readonly EngineeringAgent[]; readAt: number }>) {
  const { t } = useTranslation('agents')
  const usd = useCostText()
  const ranked = [...agents].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0))
  return (
    <div className="space-y-3">
      <AgentUse agent={agent} readAt={readAt} />
      <table className="w-full text-[12px]">
        <caption className="text-left text-[12px] font-semibold text-text-strong">{t('runWorkspace.cost.byAgent')}</caption>
        <thead><tr className="text-left text-muted"><th className="font-normal">{t('runWorkspace.cost.agent')}</th><th className="font-normal text-right">{t('runWorkspace.cost.cost')}</th></tr></thead>
        <tbody>
          {ranked.map((row) => (
            <tr key={row.agent} className={clsx(row.agent === agent.agent && 'font-semibold')}>
              <td className="font-mono break-all">{row.agent}</td>
              <td className="text-right tabular-nums">{usd(row.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
