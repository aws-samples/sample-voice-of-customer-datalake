/**
 * @fileoverview A model's use on one line, for the run page (its totals and each agent's metering): its tokens in and
 * out, and (7.58.00) for a Kiro session's model (`kiro:<model>`) the credits it used and what they cost at the
 * deployment's price per credit, which the run's cost cap counts.
 *
 * @module pages/Agents/modelUseText
 */
import { useTranslation } from 'react-i18next'

/** One model's use, as the run's overview answers it (engineeringRunsApi.ts `TokensSchema`). */
export interface ModelUse {
  readonly model: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly credits: number | null
  readonly credits_usd: number | null
}

/** The line for `row`: its credits and their cost when it reports credits, else its tokens. */
export function useModelUseText(): (row: ModelUse) => string {
  const { t, i18n } = useTranslation('agents')
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return (row) => {
    const model = row.model || '—'
    if (row.credits === null) return t('engineeringRun.modelTokens', { model, input: row.input_tokens, output: row.output_tokens })
    return t('engineeringRun.modelCredits', { model, credits: row.credits, cost: usd.format(row.credits_usd ?? 0) })
  }
}
