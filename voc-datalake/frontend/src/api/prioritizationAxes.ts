/**
 * @fileoverview The prioritization SCORING SETUP as the frontend reads it: the axis
 * ("metric") model, its lenient wire boundary, the offline default and the composite.
 *
 * One workspace-level setup (docs/prioritization.md): admins name the metrics, their
 * weights and directions; every reviewer scores every row on the same 1–5 scale
 * (0 = not scored). The backend's twin is `lambda/shared/prioritization_axes.py`; both
 * read their default from `voc-datalake/schemas/prioritization-default-axes.json`, so
 * the two cannot ship different defaults.
 *
 * Pure (Zod and the JSON only), because the public ballot page imports it on a phone.
 *
 * @module api/prioritizationAxes
 */
import { z } from 'zod'
import defaultSetup from '../../../schemas/prioritization-default-axes.json'

const AXIS_DIRECTIONS = ['higher_better', 'lower_better'] as const
export type AxisDirection = typeof AXIS_DIRECTIONS[number]

/** The four metrics the product ships with; their names come from the catalogues. */
const BUILTIN_AXIS_IDS = ['impact', 'time_to_market', 'confidence', 'strategic_fit'] as const
export type BuiltinAxisId = typeof BUILTIN_AXIS_IDS[number]

/** Every metric is scored 1–5; 0 is the "not scored" sentinel (never a vote). */
export const SCORE_MAX = defaultSetup.scale.max
export const MAX_ACTIVE_AXES = defaultSetup.max_active_axes
export const MAX_AXES = defaultSetup.max_axes
export const MAX_WEIGHT = 100
export const MAX_AXIS_LABEL = 40
export const MAX_AXIS_DESCRIPTION = 160
export const MAX_SCALE_LABEL = 24

/** An axis id as THE CONTRACT spells it: `^[a-z][a-z0-9_]{1,31}$`. */
const AXIS_ID = /^[a-z][a-z0-9_]{1,31}$/

/** One metric of the scoring setup, as the wire carries it. */
export interface ScoringAxis {
  readonly id: string
  readonly builtin: boolean
  /** `null` on a built-in = use the translated name. */
  readonly label: string | null
  readonly description: string | null
  /** Relative, 0–100; the composite normalises over the sum. */
  readonly weight: number
  readonly direction: AxisDirection
  /** What 1 and 5 mean; `null` = the default wording. */
  readonly low_label: string | null
  readonly high_label: string | null
  /** Archived metrics keep their stored ballot values but are not shown, scored or counted. */
  readonly archived: boolean
}

export const isBuiltinAxisId = (id: string): id is BuiltinAxisId => (
  BUILTIN_AXIS_IDS.some((builtin) => builtin === id)
)

/** Optional text: trimmed, empty reads as `null` (= the default wording). */
const optionalText = (max: number) => z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().slice(0, max) : value),
  z.string().nullable(),
).transform((value) => (value === null || value === '' ? null : value)).catch(null)

/**
 * One axis, lenient where a field only DECORATES and strict where it IDENTIFIES.
 *
 * `id` carries no fallback: it is the key every ballot and aggregate is stored under,
 * so an axis without a readable one has nothing to score into. A weight that cannot be
 * read degrades to 0 (still shown, counts for nothing) rather than inventing a share.
 */
const AxisSchema = z.object({
  id: z.string().regex(AXIS_ID),
  builtin: z.boolean().optional().catch(undefined),
  label: optionalText(MAX_AXIS_LABEL),
  description: optionalText(MAX_AXIS_DESCRIPTION),
  weight: z.number().transform((w) => Math.round(Math.min(MAX_WEIGHT, Math.max(0, w)))).catch(0),
  direction: z.enum(AXIS_DIRECTIONS).catch('higher_better'),
  low_label: optionalText(MAX_SCALE_LABEL),
  high_label: optionalText(MAX_SCALE_LABEL),
  archived: z.boolean().catch(false),
})

function parseAxis(raw: unknown): ScoringAxis | null {
  const parsed = AxisSchema.safeParse(raw)
  if (!parsed.success) return null
  const { builtin, ...rest } = parsed.data
  const isBuiltin = builtin ?? isBuiltinAxisId(rest.id)
  // A custom metric with no name would render as its id — the jargon the page must not show.
  if (!isBuiltin && rest.label === null) return null
  return { ...rest, builtin: isBuiltin }
}

/** Every readable axis, first occurrence of an id wins. */
function parseAxisList(raw: readonly unknown[]): ScoringAxis[] {
  return raw.reduce<ScoringAxis[]>((kept, entry) => {
    const axis = parseAxis(entry)
    return axis === null || kept.some((other) => other.id === axis.id) ? kept : [...kept, axis]
  }, [])
}

/** The setup the product ships with — the same file the backend's default is pinned to. */
export const DEFAULT_AXES: readonly ScoringAxis[] = parseAxisList(defaultSetup.axes)

/**
 * The configured axes from whatever the wire sent.
 *
 * ABSENT (a deployment predating configurable metrics) answers the default — the four
 * metrics it was scoring on all along. A list that yields no ACTIVE axis also answers the
 * default: the page needs something to score with, and every stored ballot is keyed by
 * those four ids, so they are the only honest guess.
 */
export function normalizeAxes(raw: unknown): readonly ScoringAxis[] {
  if (!Array.isArray(raw)) return DEFAULT_AXES
  const axes = parseAxisList(raw)
  return axes.some((axis) => !axis.archived) ? axes : DEFAULT_AXES
}

/** The axes people see, score and count — in the configured order. */
export const activeAxes = (axes: readonly ScoringAxis[]): readonly ScoringAxis[] => (
  axes.filter((axis) => !axis.archived)
)

/** The config version the setup was read at (`0` = nothing stored yet). */
export const configVersionOf = (raw: unknown): number => {
  const parsed = z.number().int().min(0).safeParse(raw)
  return parsed.success ? parsed.data : 0
}

/** `values[id]` when it is a score (1–5, or a team mean in between), else `null`. */
function scoredValue(values: Readonly<Record<string, number>>, id: string): number | null {
  const value = Object.hasOwn(values, id) ? values[id] : undefined
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null
}

/** The value as the composite counts it: higher is better on every axis after this. */
const oriented = (axis: ScoringAxis, value: number): number => (
  axis.direction === 'lower_better' ? (SCORE_MAX + 1) - value : value
)

/**
 * THE composite (the backend computes the same, `prioritization_axes.composite`):
 *
 *     composite = Σ w·v' / Σ w   over the ACTIVE axes this ballot scored
 *
 * `v' = v` for higher_better and `6 − v` for lower_better; an unscored axis (0 or absent)
 * is left out of BOTH sums, so one ballot of impact 4 alone reads 4.0 rather than being
 * outvoted by zeros nobody entered (#343). `null` when nothing weighted was scored.
 * Works on one ballot and on the team's per-axis means alike.
 */
export function compositeScore(
  axes: readonly ScoringAxis[],
  values: Readonly<Record<string, number>>,
): number | null {
  const sums = activeAxes(axes).reduce((acc, axis) => {
    const value = scoredValue(values, axis.id)
    if (value === null) return acc
    return { weighted: acc.weighted + axis.weight * oriented(axis, value), weight: acc.weight + axis.weight }
  }, { weighted: 0, weight: 0 })
  return sums.weight > 0 ? sums.weighted / sums.weight : null
}

/** Each active axis's share of the composite, in whole percent (sums to ~100). */
export function weightShares(axes: readonly ScoringAxis[]): Readonly<Record<string, number>> {
  const active = activeAxes(axes)
  const total = active.reduce((sum, axis) => sum + axis.weight, 0)
  return Object.fromEntries(active.map((axis) => [axis.id, total > 0 ? Math.round((axis.weight / total) * 100) : 0]))
}

/** The active axes by weight, heaviest first; ties keep the configured order. */
export function axesByWeight(axes: readonly ScoringAxis[]): readonly ScoringAxis[] {
  return [...activeAxes(axes)].sort((a, b) => b.weight - a.weight)
}
