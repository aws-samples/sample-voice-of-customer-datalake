/**
 * @fileoverview The inspector's Cost tab (7.51.00): what the open agent used (its cost at its tokens' prices, its
 * tokens per model, its MicroVM time, its model, skill, attempt and commit), and every agent of the run beside it,
 * costliest first, from the overview.
 *
 * @module pages/Agents/RunWorkspace/CostTab
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

function useCostText(): (value: number | null) => string {
  const { i18n } = useTranslation()
  const format = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return (value) => (value === null ? '—' : format.format(value))
}

function AgentUse({ agent }: Readonly<{ agent: EngineeringAgent }>) {
  const { t } = useTranslation('agents')
  const usd = useCostText()
  const facts: [string, string][] = [
    [t('runWorkspace.cost.cost'), usd(agent.cost_usd)],
    [t('runWorkspace.cost.microvm'), t('engineeringRun.agent.microvmTime', { seconds: agent.microvm_seconds })],
    [t('runWorkspace.cost.model'), agent.model ?? '—'],
    [t('runWorkspace.cost.skill'), agent.skill_label ?? '—'],
    [t('runWorkspace.cost.attempt'), String(agent.attempt)],
    [t('runWorkspace.cost.commit'), agent.commit === null ? '—' : agent.commit.slice(0, 12)],
  ]
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]">
        {facts.map(([name, value]) => <div key={name} className="contents"><dt className="text-muted">{name}</dt><dd className="break-all">{value}</dd></div>)}
      </dl>
      {agent.tokens.length > 0 && (
        <ul className="text-[12px]" aria-label={t('engineeringRun.byModel')}>
          {agent.tokens.map((row) => (
            <li key={row.model}>{t('engineeringRun.modelTokens', { model: row.model || '—', input: row.input_tokens, output: row.output_tokens })}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function CostTab({ agent, agents }: Readonly<{ agent: EngineeringAgent; agents: readonly EngineeringAgent[] }>) {
  const { t } = useTranslation('agents')
  const usd = useCostText()
  const ranked = [...agents].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0))
  return (
    <div className="space-y-3">
      <AgentUse agent={agent} />
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
