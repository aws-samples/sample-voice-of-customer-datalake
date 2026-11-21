/**
 * @fileoverview A leadership view as `GET /metrics/adoption` answers it (lambda/shared/adoption_view.py), for the specs.
 * @module pages/Leadership/leadership-fixtures
 */
import type { AdoptionPeriod, AdoptionView } from '../../api/adoptionApi'

function period(label: string, overrides: Partial<AdoptionPeriod> = {}): AdoptionPeriod {
  return {
    period: label, months: [label], projects_started: 4,
    with: { personas: 4, research: 2, prfaq: 3, prd: 3, prototype: 2, validation: 1 },
    prototype_rate: 0.5,
    artifacts: { personas: { ai: 6, human: 1 }, research: { ai: 2, human: 0 }, prfaq: { ai: 2, human: 1 },
      prd: { ai: 3, human: 0 }, prototype: { ai: 2, human: 0 } },
    decisions: { pursue: 2, park: 1, reject: 0, total: 3 }, validated_decisions: 1, validation_reports: 1,
    validation_runs: { real: 0, synthetic: 2 },
    cycle_days: { evidence_to_prd: { median: 6.5, n: 3 }, prd_to_prototype: { median: 4, n: 2 },
      prototype_to_decision: { median: null, n: 0 } },
    assistant_conversations: 12, agent_runs: 3, time_saved_hours: 83,
    ...overrides,
  }
}

export function leadershipView(overrides: Partial<AdoptionView> = {}): AdoptionView {
  const baseline = (hours: number, saved = false) => ({ hours, saved })
  return {
    scope: 'deployment', grain: 'month', from: '2026-10', to: '2026-11', as_of: '2026-11-21T03:05:00+00:00',
    complete: true, covered_from: '2024-12', agent_runs_counted: true,
    periods: [period('2026-10'), period('2026-11')],
    totals: period('total', { projects_started: 8, time_saved_hours: 166 }),
    time_saved: {
      estimate: true, label: 'Estimate, not a measurement', unit: 'hours',
      baselines: { personas: baseline(1.5), research: baseline(6), prfaq: baseline(4), prd: baseline(10, true),
        prototype: baseline(16) },
      note: '=From our survey', updated_at: '2026-11-20T00:00:00Z',
      assumptions: [{ code: 'ai_made_only', text: 'Only AI-made artifacts count.' },
        { code: 'review_not_subtracted', text: 'Review time is not subtracted.' }],
    },
    ...overrides,
  }
}
