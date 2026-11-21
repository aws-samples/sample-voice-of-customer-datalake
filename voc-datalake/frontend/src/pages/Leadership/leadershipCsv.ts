/**
 * @fileoverview The leadership view as CSV (pure; the page downloads it): one row per period and one for the range's
 * total, every column a count, a rate, a median or the estimate's hours, then the estimate's label, its baselines and
 * its assumptions as trailing lines, so the hours never travel without them. Counts only: no person, no name. Every
 * field goes through `csvField` (formula-injection guard), the admin's note included.
 * @module pages/Leadership/leadershipCsv
 */
import { ARTIFACT_TYPES, COHORT_STEPS, CYCLES, VERDICTS } from '../../api/adoptionApi'
import type { AdoptionPeriod, AdoptionView } from '../../api/adoptionApi'
import { csvField } from '../../utils/csv'

/** The header row, in column order (English ids: a CSV is read by tools, the page words them). */
export const CSV_COLUMNS = [
  'period', 'projects_started',
  ...COHORT_STEPS.map((step) => `with_${step}`),
  'prototype_rate', 'validation_reports', 'validation_runs_real', 'validation_runs_synthetic',
  ...VERDICTS.map((verdict) => `decisions_${verdict}`), 'validated_decisions',
  ...CYCLES.flatMap((cycle) => [`${cycle}_median_days`, `${cycle}_n`]),
  ...ARTIFACT_TYPES.flatMap((type) => [`${type}_with_ai`, `${type}_by_hand`]),
  'assistant_conversations', 'agent_runs', 'time_saved_hours_estimate',
] as const

function row(period: AdoptionPeriod): (string | number | null)[] {
  return [
    period.period, period.projects_started,
    ...COHORT_STEPS.map((step) => period.with[step]),
    period.prototype_rate, period.validation_reports, period.validation_runs.real, period.validation_runs.synthetic,
    ...VERDICTS.map((verdict) => period.decisions[verdict]), period.validated_decisions,
    ...CYCLES.flatMap((cycle) => [period.cycle_days[cycle].median, period.cycle_days[cycle].n]),
    ...ARTIFACT_TYPES.flatMap((type) => [period.artifacts[type].ai, period.artifacts[type].human]),
    period.assistant_conversations, period.agent_runs, period.time_saved_hours,
  ]
}

const line = (fields: readonly (string | number | null)[]) => fields.map((field) => csvField(field)).join(',')

/** The whole file: the table, a blank line, then the estimate's label, baselines and assumptions. */
export function leadershipCsv(view: AdoptionView): string {
  const saved = view.time_saved
  const lines = [
    line(CSV_COLUMNS),
    ...[...view.periods, view.totals].map((period) => line(row(period))),
    '',
    line(['estimate', saved.label]),
    ...ARTIFACT_TYPES.map((type) => line([`baseline_hours_${type}`, saved.baselines[type].hours,
      saved.baselines[type].saved ? 'set by an admin' : 'default'])),
    ...(saved.note === null ? [] : [line(['note', saved.note])]),
    ...saved.assumptions.map((assumption) => line(['assumption', assumption.text])),
    line(['as_of', view.as_of]),
  ]
  // A BOM, so a spreadsheet reads it as UTF-8.
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** Offer the file for download in the browser. */
export function downloadLeadershipCsv(view: AdoptionView): void {
  const url = URL.createObjectURL(new Blob([leadershipCsv(view)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `leadership-${view.scope}-${view.from}-${view.to}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
