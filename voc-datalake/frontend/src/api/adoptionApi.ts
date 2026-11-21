/**
 * @fileoverview The leadership view (7.70.00, docs/leadership-view.md): `GET /metrics/adoption` (metrics Lambda,
 * `lambda/shared/adoption_metrics_routes.py`) and its time-saved baselines, `GET|PUT /settings/adoption` (settings
 * Lambda, `lambda/shared/adoption_routes.py`; the page saves them from the assumptions drawer and reads them in the
 * view's own `time_saved`).
 *
 * The view is counts only, by month or quarter, of the request's scope (the workspace, else the deployment): never a
 * person. Its `time_saved` is an estimate the server labels and explains: the page always shows the label, the
 * baselines and the assumptions beside the hours. Read leniently: a drifted answer reads as zeros, never as a crash.
 *
 * @module api/adoptionApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { put } from './requestKit'

/** The artifacts the estimate counts, in methodology order (`ARTIFACT_TYPES` in lambda/shared/adoption.py). */
export const ARTIFACT_TYPES = ['personas', 'research', 'prfaq', 'prd', 'prototype'] as const
export type ArtifactType = typeof ARTIFACT_TYPES[number]
/** The steps a project started in a period is counted "with" (`COHORT_STEPS` in lambda/shared/adoption_rollup.py). */
export const COHORT_STEPS = [...ARTIFACT_TYPES, 'validation'] as const
/** The three cycle times (`CYCLES`). */
export const CYCLES = ['evidence_to_prd', 'prd_to_prototype', 'prototype_to_decision'] as const
export const VERDICTS = ['pursue', 'park', 'reject'] as const
export const GRAINS = ['month', 'quarter'] as const
export type Grain = typeof GRAINS[number]

const count = z.number().int().nonnegative().catch(0)
/** A schema whose every field catches, read as its all-zero self when the whole value is unreadable. */
function lenient<T extends z.ZodRawShape>(shape: T) {
  const base = z.object(shape)
  return base.catch(() => base.parse({}))
}
const MadeSchema = lenient({ ai: count, human: count })
const CycleSchema = lenient({ median: z.number().nullable().catch(null), n: count })

const PeriodSchema = z.object({
  period: z.string(),
  months: z.array(z.string()).catch([]),
  projects_started: count,
  with: lenient({ personas: count, research: count, prfaq: count, prd: count, prototype: count, validation: count }),
  prototype_rate: z.number().nullable().catch(null),
  artifacts: lenient({ personas: MadeSchema, research: MadeSchema, prfaq: MadeSchema, prd: MadeSchema,
    prototype: MadeSchema }),
  decisions: lenient({ pursue: count, park: count, reject: count, total: count }),
  validated_decisions: count,
  validation_reports: count,
  validation_runs: lenient({ real: count, synthetic: count }),
  cycle_days: lenient({ evidence_to_prd: CycleSchema, prd_to_prototype: CycleSchema,
    prototype_to_decision: CycleSchema }),
  assistant_conversations: count,
  agent_runs: count,
  time_saved_hours: z.number().nonnegative().catch(0),
})
export type AdoptionPeriod = z.output<typeof PeriodSchema>

const BaselineSchema = lenient({ hours: z.number().nonnegative().catch(0), saved: z.boolean().catch(false) })
const BaselinesSchema = lenient({ personas: BaselineSchema, research: BaselineSchema, prfaq: BaselineSchema,
  prd: BaselineSchema, prototype: BaselineSchema })

const AssumptionSchema = z.object({ code: z.string(), text: z.string() })

const ViewSchema = z.object({
  scope: z.enum(['workspace', 'deployment']).catch('deployment'),
  grain: z.enum(GRAINS).catch('month'),
  from: z.string(),
  to: z.string(),
  as_of: z.string().nullable().catch(null),
  complete: z.boolean().catch(true),
  covered_from: z.string().nullable().catch(null),
  agent_runs_counted: z.boolean().catch(false),
  periods: z.array(PeriodSchema).catch([]),
  totals: PeriodSchema,
  time_saved: z.object({
    estimate: z.literal(true).catch(true),
    label: z.string().catch(''),
    unit: z.literal('hours').catch('hours'),
    baselines: BaselinesSchema,
    note: z.string().nullable().catch(null),
    updated_at: z.string().nullable().catch(null),
    assumptions: z.array(AssumptionSchema).catch([]),
  }),
})
export type AdoptionView = z.output<typeof ViewSchema>

const SettingsSchema = z.object({
  baselines: BaselinesSchema,
  defaults: z.record(z.string(), z.number()).catch({}),
  note: z.string().nullable().catch(null),
  updated_at: z.string().nullable().catch(null),
  max_hours: z.number().catch(200),
  max_note_chars: z.number().catch(500),
})
type AdoptionSettings = z.output<typeof SettingsSchema>

/** A save names only what it changes; a type set to `null` goes back to its default. */
interface AdoptionSettingsChanges {
  readonly baselines?: Partial<Record<ArtifactType, number | null>>
  readonly note?: string | null
}

export interface AdoptionRange {
  readonly from: string
  readonly to: string
  readonly grain: Grain
}

export const adoptionKey = (range: AdoptionRange) => ['metrics', 'adoption', range.from, range.to, range.grain] as const

const VIEW_PATH = '/metrics/adoption'
const SETTINGS_PATH = '/settings/adoption'

export const adoptionApi = {
  view: async (range: AdoptionRange): Promise<AdoptionView> => {
    const query = new URLSearchParams({ from: range.from, to: range.to, grain: range.grain })
    return ViewSchema.parse(await fetchApi<unknown>(`${VIEW_PATH}?${query.toString()}`))
  },
  saveSettings: async (changes: AdoptionSettingsChanges): Promise<AdoptionSettings> =>
    SettingsSchema.parse(await fetchApi<unknown>(SETTINGS_PATH, put(changes))),
}
