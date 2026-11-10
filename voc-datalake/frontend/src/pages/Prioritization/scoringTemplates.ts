/**
 * @fileoverview Ready-made scoring setups for the editor: Current default, RICE, ICE and
 * Value vs Effort — all on the same 1–5 scale. Frontend-only constants (THE CONTRACT),
 * translated; applying one changes only the DRAFT until the admin presses Save.
 *
 * Applying ARCHIVES the current metrics the template does not use (their ballot values
 * stay stored) and adds or restores the template's — reusing a stored metric where one
 * matches: a built-in by id (impact, confidence), a custom one by id or by name.
 * @module pages/Prioritization/scoringTemplates
 */
import type { AxisDirection } from '../../api/prioritizationAxes'
import { builtinDraftAxis } from './scoringDraft'
import type { DraftAxis } from './scoringDraft'

type QualifiedKey = `prioritization:${string}`
type Translate = (key: string) => string

export const SCORING_TEMPLATE_IDS = ['default', 'rice', 'ice', 'value_effort'] as const
export type ScoringTemplateId = typeof SCORING_TEMPLATE_IDS[number]

/** A template metric: a built-in (named by the catalogue, no `text`) or a custom one with its words. */
interface TemplateAxis {
  /** The built-in id, or the slug a custom metric is expected to get (`reach`, `effort`). */
  readonly id: string
  readonly weight: number
  readonly direction: AxisDirection
  /** Custom metrics only. */
  readonly text?: {
    readonly nameKey: QualifiedKey
    readonly descriptionKey: QualifiedKey
    readonly lowKey: QualifiedKey
    readonly highKey: QualifiedKey
  }
}

const builtin = (id: string, weight: number): TemplateAxis => ({ id, weight, direction: 'higher_better' })

const REACH: TemplateAxis = {
  id: 'reach', weight: 30, direction: 'higher_better',
  text: {
    nameKey: 'prioritization:setup.templateAxes.reach',
    descriptionKey: 'prioritization:setup.templateAxes.reachDescription',
    lowKey: 'prioritization:setup.templateAxes.reachLow',
    highKey: 'prioritization:setup.templateAxes.reachHigh',
  },
}

const effort = (weight: number): TemplateAxis => ({
  id: 'effort', weight, direction: 'lower_better',
  text: {
    nameKey: 'prioritization:setup.templateAxes.effort',
    descriptionKey: 'prioritization:setup.templateAxes.effortDescription',
    lowKey: 'prioritization:setup.templateAxes.effortLow',
    highKey: 'prioritization:setup.templateAxes.effortHigh',
  },
})

const EASE: TemplateAxis = {
  id: 'ease', weight: 30, direction: 'higher_better',
  text: {
    nameKey: 'prioritization:setup.templateAxes.ease',
    descriptionKey: 'prioritization:setup.templateAxes.easeDescription',
    lowKey: 'prioritization:setup.templateAxes.easeLow',
    highKey: 'prioritization:setup.templateAxes.easeHigh',
  },
}

const VALUE: TemplateAxis = {
  id: 'value', weight: 60, direction: 'higher_better',
  text: {
    nameKey: 'prioritization:setup.templateAxes.value',
    descriptionKey: 'prioritization:setup.templateAxes.valueDescription',
    lowKey: 'prioritization:scores.low',
    highKey: 'prioritization:scores.high',
  },
}

const TEMPLATES: Record<ScoringTemplateId, readonly TemplateAxis[]> = {
  default: [builtin('impact', 40), builtin('time_to_market', 30), builtin('strategic_fit', 20), builtin('confidence', 10)],
  rice: [REACH, builtin('impact', 30), builtin('confidence', 20), effort(20)],
  ice: [builtin('impact', 40), builtin('confidence', 30), EASE],
  value_effort: [VALUE, effort(40)],
}

/** What each template is called and what it is for, in the picker. */
export const TEMPLATE_TEXT: Record<ScoringTemplateId, { readonly nameKey: QualifiedKey; readonly descriptionKey: QualifiedKey }> = {
  default: { nameKey: 'prioritization:setup.templates.default', descriptionKey: 'prioritization:setup.templates.defaultDescription' },
  rice: { nameKey: 'prioritization:setup.templates.rice', descriptionKey: 'prioritization:setup.templates.riceDescription' },
  ice: { nameKey: 'prioritization:setup.templates.ice', descriptionKey: 'prioritization:setup.templates.iceDescription' },
  value_effort: { nameKey: 'prioritization:setup.templates.valueEffort', descriptionKey: 'prioritization:setup.templates.valueEffortDescription' },
}

const sameName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/** The draft metric a template metric reuses, if any. */
function matchOf(draft: readonly DraftAxis[], axis: TemplateAxis, t: Translate): DraftAxis | undefined {
  const byId = draft.find((existing) => existing.id === axis.id)
  if (byId !== undefined || axis.text === undefined) return byId
  const name = t(axis.text.nameKey)
  return draft.find((existing) => !existing.builtin && sameName(existing.label, name))
}

/** A template metric as a new draft row (custom metrics get their translated words). */
function newDraftAxis(axis: TemplateAxis, t: Translate): DraftAxis {
  if (axis.text === undefined) return { ...builtinDraftAxis(axis.id, t), weight: axis.weight }
  return {
    key: `template-${axis.id}`, id: null, builtin: false,
    label: t(axis.text.nameKey), description: t(axis.text.descriptionKey),
    weight: axis.weight, direction: axis.direction,
    lowLabel: t(axis.text.lowKey), highLabel: t(axis.text.highKey), archived: false,
  }
}

/** What applying a template would do — the confirm says it in words before it happens. */
export interface TemplateChange {
  readonly draft: DraftAxis[]
  /** Metric names after applying, in order. */
  readonly metrics: string[]
  /** Currently active metrics the template archives (their scores are kept). */
  readonly archived: string[]
}

/** The draft with `templateId` applied (nothing is saved until the admin presses Save). */
export function applyTemplate(
  draft: readonly DraftAxis[],
  templateId: ScoringTemplateId,
  t: Translate,
): TemplateChange {
  const template = TEMPLATES[templateId]
  const placed = template.map((axis) => {
    const match = matchOf(draft, axis, t)
    return match === undefined
      ? newDraftAxis(axis, t)
      : { ...match, weight: axis.weight, direction: axis.direction, archived: false }
  })
  const placedKeys = new Set(placed.map((axis) => axis.key))
  const rest = draft.filter((axis) => !placedKeys.has(axis.key))
  return {
    // A never-saved metric the template does not use has nothing stored: it is dropped.
    draft: [...placed, ...rest.filter((axis) => axis.id !== null).map((axis) => ({ ...axis, archived: true }))],
    metrics: placed.map((axis) => axis.label),
    archived: rest.filter((axis) => !axis.archived).map((axis) => axis.label),
  }
}
