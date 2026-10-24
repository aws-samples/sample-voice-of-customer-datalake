/**
 * @fileoverview The Scoring setup editor's working copy: the metrics as the form edits
 * them, the checks a save must pass (THE CONTRACT's 400s, said before the request), and
 * the body the save sends. Pure, so every rule is unit-tested without rendering.
 * @module pages/Prioritization/scoringDraft
 */
import {
  MAX_ACTIVE_AXES, MAX_AXES, MAX_AXIS_DESCRIPTION, MAX_AXIS_LABEL, MAX_SCALE_LABEL, MAX_WEIGHT,
} from '../../api/prioritizationAxes'
import type { AxisDirection, ScoringAxis } from '../../api/prioritizationAxes'
import type { AxisInput } from '../../api/prioritizationConfigApi'
import { axisText } from './axisText'

/**
 * One metric in the editor. Text fields are plain strings (what the inputs hold); a
 * built-in's are seeded with its translated wording, and saving that wording unchanged
 * sends `null` — "use the translation" — so a renamed-back built-in stays translated.
 */
export interface DraftAxis {
  /** React key: the id for a stored metric, a local token for a new one. */
  readonly key: string
  /** `null` until the server mints one on save. */
  readonly id: string | null
  readonly builtin: boolean
  readonly label: string
  readonly description: string
  readonly weight: number
  readonly direction: AxisDirection
  readonly lowLabel: string
  readonly highLabel: string
  readonly archived: boolean
}

type Translate = (key: string) => string

/** The translated wording a built-in falls back to (what `null` means on the wire). */
function defaultWording(axis: Pick<DraftAxis, 'id' | 'builtin'>, t: Translate) {
  return axisText({ id: axis.id ?? '', label: null, description: null, low_label: null, high_label: null }, t)
}

/** One stored metric as an editor row. */
function draftOf(axis: ScoringAxis, t: Translate): DraftAxis {
  const text = axisText(axis, t)
  return {
    key: axis.id,
    id: axis.id,
    builtin: axis.builtin,
    label: text.name,
    description: text.description,
    weight: axis.weight,
    direction: axis.direction,
    lowLabel: text.lowLabel,
    highLabel: text.highLabel,
    archived: axis.archived,
  }
}

export function draftFromAxes(axes: readonly ScoringAxis[], t: Translate): DraftAxis[] {
  return axes.map((axis) => draftOf(axis, t))
}

/** A built-in metric with its translated wording, for a template that needs one the draft lacks. */
export function builtinDraftAxis(id: string, t: Translate): DraftAxis {
  return draftOf({
    id, builtin: true, label: null, description: null, weight: 0, direction: 'higher_better',
    low_label: null, high_label: null, archived: false,
  }, t)
}

/** `null` for empty text, and for a built-in's text left at its translation. */
const wireText = (value: string, fallback: string | null): string | null => {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === fallback ? null : trimmed
}

/**
 * The save body: active metrics in their on-screen order, then archived ones. A NEW
 * metric carries no `id` (the server mints one from its label).
 */
export function toAxisInputs(draft: readonly DraftAxis[], t: Translate): AxisInput[] {
  const ordered = [...draft.filter((axis) => !axis.archived), ...draft.filter((axis) => axis.archived)]
  return ordered.map((axis) => {
    const wording = defaultWording(axis, t)
    const fallback = (value: string) => (axis.builtin ? value : null)
    return {
      ...(axis.id === null ? {} : { id: axis.id }),
      label: wireText(axis.label, fallback(wording.name)),
      description: wireText(axis.description, fallback(wording.description)),
      weight: axis.weight,
      direction: axis.direction,
      // A custom metric's 1/5 words default to "Low"/"High" too, so those mean `null`.
      low_label: wireText(axis.lowLabel, wording.lowLabel),
      high_label: wireText(axis.highLabel, wording.highLabel),
      archived: axis.archived,
    }
  })
}

/** Why the draft cannot be saved — each has a sentence in the editor. */
export type DraftProblem = 'missingName' | 'noActive' | 'tooManyActive' | 'tooMany' | 'noWeight'

export function draftProblems(draft: readonly DraftAxis[]): DraftProblem[] {
  const active = draft.filter((axis) => !axis.archived)
  const checks: [DraftProblem, boolean][] = [
    ['missingName', active.some((axis) => !axis.builtin && axis.label.trim() === '')],
    ['noActive', active.length === 0],
    ['tooManyActive', active.length > MAX_ACTIVE_AXES],
    ['tooMany', draft.length > MAX_AXES],
    ['noWeight', active.length > 0 && active.every((axis) => axis.weight <= 0)],
  ]
  return checks.filter(([, failed]) => failed).map(([problem]) => problem)
}

export const canAddAxis = (draft: readonly DraftAxis[]): boolean => (
  draft.filter((axis) => !axis.archived).length < MAX_ACTIVE_AXES && draft.length < MAX_AXES
)

/** Each active metric's live share of the composite, in whole percent. */
export function draftShares(draft: readonly DraftAxis[]): Readonly<Record<string, number>> {
  const active = draft.filter((axis) => !axis.archived)
  const total = active.reduce((sum, axis) => sum + axis.weight, 0)
  return Object.fromEntries(active.map((axis) => [axis.key, total > 0 ? Math.round((axis.weight / total) * 100) : 0]))
}

/** The fields a reviewer can edit on one metric. */
export type DraftEdit = Partial<Pick<DraftAxis, 'label' | 'description' | 'weight' | 'direction' | 'lowLabel' | 'highLabel'>>

const clampWeight = (weight: number): number => (
  Number.isFinite(weight) ? Math.round(Math.min(MAX_WEIGHT, Math.max(0, weight))) : 0
)

export function updateAxis(draft: readonly DraftAxis[], key: string, edit: DraftEdit): DraftAxis[] {
  return draft.map((axis) => (axis.key === key ? {
    ...axis,
    ...edit,
    ...(edit.weight === undefined ? {} : { weight: clampWeight(edit.weight) }),
  } : axis))
}

/** A new, unnamed metric at the end of the active list. */
export function addAxis(draft: readonly DraftAxis[], key: string): DraftAxis[] {
  return [...draft, {
    key, id: null, builtin: false, label: '', description: '', weight: 10, direction: 'higher_better',
    lowLabel: '', highLabel: '', archived: false,
  }]
}

/**
 * Archive (never delete) a STORED metric: its ballot values stay on the server. A metric
 * that was never saved has nothing stored, so archiving it simply removes it.
 */
export function archiveAxis(draft: readonly DraftAxis[], key: string): DraftAxis[] {
  return draft.flatMap((axis) => {
    if (axis.key !== key) return [axis]
    return axis.id === null ? [] : [{ ...axis, archived: true }]
  })
}

export function restoreAxis(draft: readonly DraftAxis[], key: string): DraftAxis[] {
  return draft.map((axis) => (axis.key === key ? { ...axis, archived: false } : axis))
}

/** Move an active metric one place up (-1) or down (+1) among the ACTIVE metrics. */
export function moveAxis(draft: readonly DraftAxis[], key: string, delta: -1 | 1): DraftAxis[] {
  const active = draft.filter((axis) => !axis.archived)
  const from = active.findIndex((axis) => axis.key === key)
  const moving = active[from]
  const other = active[from + delta]
  if (moving === undefined || other === undefined) return [...draft]
  const swap = (axis: DraftAxis, index: number): DraftAxis => {
    if (index === from) return other
    return index === from + delta ? moving : axis
  }
  return [...active.map(swap), ...draft.filter((axis) => axis.archived)]
}

/** Limits the inputs enforce, re-exported so the form reads one place. */
export const DRAFT_LIMITS = {
  label: MAX_AXIS_LABEL, description: MAX_AXIS_DESCRIPTION, scaleLabel: MAX_SCALE_LABEL, weight: MAX_WEIGHT,
}
