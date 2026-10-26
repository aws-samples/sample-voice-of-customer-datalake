/**
 * @fileoverview The editable copy of the dimensions config and its checks.
 *
 * Rows carry a client `uid` so React keys stay stable while an admin retypes
 * a key or a value name. {@link toWire} strips it. {@link draftProblem} mirrors
 * `validate_dimensions` closely enough to refuse an obviously doomed save with
 * a precise message; the server stays the authority.
 *
 * @module components/DimensionsManager/dimensionDraft
 */
import {
  DIMENSION_KEY_RE, DIMENSION_VALUE_RE, MAX_DESCRIPTION_CHARS, MAX_DIMENSIONS, MAX_DIMENSION_VALUES,
  MAX_LABEL_CHARS, RESERVED_DIMENSION_KEYS,
} from '../../api/dimensionsSchema'
import { newClientId } from '../../api/schemaList'
import type { Dimension, DimensionValue } from '../../api/dimensionsSchema'

export interface DraftValue extends DimensionValue { uid: string }
export interface DraftDimension extends Omit<Dimension, 'values'> { uid: string; values: DraftValue[] }

/** A translation key (components:dimensionsManager.problems.*) and its parameters. */
export interface DraftProblem {
  messageKey: string
  params: Record<string, string | number>
}

export function toDraft(dimensions: readonly Dimension[]): DraftDimension[] {
  return dimensions.map((d) => ({ ...d, uid: newClientId('dim'), values: d.values.map((v) => ({ ...v, uid: newClientId('val') })) }))
}

/** Trimmed text, or undefined when blank (so the field is omitted). */
function filled(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? undefined : trimmed
}

function valueToWire(value: DraftValue, hasParent: boolean): DimensionValue {
  const label = filled(value.label)
  const description = filled(value.description)
  const parentValue = hasParent ? filled(value.parent_value) : undefined
  return {
    name: value.name.trim(),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    ...(parentValue === undefined ? {} : { parent_value: parentValue }),
  }
}

/** The PUT body's `dimensions`: no uids, trimmed text, blanks omitted. */
export function toWire(draft: readonly DraftDimension[]): Dimension[] {
  return draft.map((d) => {
    const hasParent = d.parent !== undefined && d.parent !== ''
    const description = filled(d.description)
    return {
      key: d.key.trim(),
      label: d.label.trim() === '' ? d.key.trim() : d.label.trim(),
      infer: d.infer,
      values: d.values.map((v) => valueToWire(v, hasParent)),
      ...(description === undefined ? {} : { description }),
      ...(hasParent ? { parent: d.parent } : {}),
    }
  })
}

export function newDimension(): DraftDimension {
  return { uid: newClientId('dim'), key: '', label: '', infer: true, values: [] }
}

export function newValue(name: string): DraftValue {
  return { uid: newClientId('val'), name }
}

/**
 * The draft with dimension `uid` replaced by `next`; when its key changed, the
 * children that named the old key follow it.
 */
export function replaceDimension(draft: readonly DraftDimension[], uid: string, next: DraftDimension): DraftDimension[] {
  const previousKey = draft.find((d) => d.uid === uid)?.key
  return draft.map((d) => {
    if (d.uid === uid) return next
    return previousKey !== undefined && previousKey !== '' && d.parent === previousKey ? { ...d, parent: next.key } : d
  })
}

/** The draft without dimension `uid`; its children become top-level (their parent values are dropped on save). */
export function removeDimension(draft: readonly DraftDimension[], uid: string): DraftDimension[] {
  const removedKey = draft.find((d) => d.uid === uid)?.key
  return draft
    .filter((d) => d.uid !== uid)
    .map((d) => (removedKey !== undefined && d.parent === removedKey ? { ...d, parent: undefined } : d))
}

/** Keys of the dimensions that name `key` as their parent. */
export function childrenOf(draft: readonly DraftDimension[], key: string): string[] {
  return draft.filter((d) => d.parent === key && key !== '').map((d) => d.key)
}

/** Top-level dimensions `dimension` may hang under (not itself; none while it has children). */
export function parentOptions(draft: readonly DraftDimension[], dimension: DraftDimension): DraftDimension[] {
  if (childrenOf(draft, dimension.key).length > 0) return []
  return draft.filter((d) => d.uid !== dimension.uid && d.parent === undefined && DIMENSION_KEY_RE.test(d.key))
}

const problem = (messageKey: string, params: Record<string, string | number> = {}): DraftProblem => ({ messageKey, params })

// Held as `…Key:` data so scripts/i18n-check.mjs sees every one.
const PROBLEMS = {
  tooMany: { messageKey: 'components:dimensionsManager.problems.tooMany' },
  keyFormat: { messageKey: 'components:dimensionsManager.problems.keyFormat' },
  keyReserved: { messageKey: 'components:dimensionsManager.problems.keyReserved' },
  keyDuplicate: { messageKey: 'components:dimensionsManager.problems.keyDuplicate' },
  labelLength: { messageKey: 'components:dimensionsManager.problems.labelLength' },
  descriptionLength: { messageKey: 'components:dimensionsManager.problems.descriptionLength' },
  parentInvalid: { messageKey: 'components:dimensionsManager.problems.parentInvalid' },
  parentValueMissing: { messageKey: 'components:dimensionsManager.problems.parentValueMissing' },
  tooManyValues: { messageKey: 'components:dimensionsManager.problems.tooManyValues' },
  valueFormat: { messageKey: 'components:dimensionsManager.problems.valueFormat' },
  valueDuplicate: { messageKey: 'components:dimensionsManager.problems.valueDuplicate' },
} as const

function keyProblem(dimension: DraftDimension): DraftProblem | null {
  const key = dimension.key.trim()
  if (!DIMENSION_KEY_RE.test(key)) return problem(PROBLEMS.keyFormat.messageKey, { key })
  if (RESERVED_DIMENSION_KEYS.has(key)) return problem(PROBLEMS.keyReserved.messageKey, { key })
  if (dimension.label.length > MAX_LABEL_CHARS) return problem(PROBLEMS.labelLength.messageKey, { key, max: MAX_LABEL_CHARS })
  if ((dimension.description ?? '').length > MAX_DESCRIPTION_CHARS) return problem(PROBLEMS.descriptionLength.messageKey, { key, max: MAX_DESCRIPTION_CHARS })
  return null
}

function parentProblem(dimension: DraftDimension, byKey: ReadonlyMap<string, DraftDimension>): DraftProblem | null {
  if (dimension.parent === undefined) return null
  const parent = byKey.get(dimension.parent)
  if (parent === undefined || parent.parent !== undefined || parent.uid === dimension.uid) {
    return problem(PROBLEMS.parentInvalid.messageKey, { key: dimension.key })
  }
  const parentNames = new Set(parent.values.map((v) => v.name.trim()))
  const orphan = dimension.values.find((v) => v.parent_value !== undefined && v.parent_value !== '' && !parentNames.has(v.parent_value))
  return orphan === undefined ? null : problem(PROBLEMS.parentValueMissing.messageKey, { key: dimension.key, value: orphan.name })
}

function valuesProblem(dimension: DraftDimension): DraftProblem | null {
  if (dimension.values.length > MAX_DIMENSION_VALUES) return problem(PROBLEMS.tooManyValues.messageKey, { key: dimension.key, max: MAX_DIMENSION_VALUES })
  const names = dimension.values.map((v) => v.name.trim())
  const bad = names.find((name) => !DIMENSION_VALUE_RE.test(name))
  if (bad !== undefined) return problem(PROBLEMS.valueFormat.messageKey, { key: dimension.key, value: bad })
  const duplicate = names.find((name, i) => names.indexOf(name) !== i)
  return duplicate === undefined ? null : problem(PROBLEMS.valueDuplicate.messageKey, { key: dimension.key, value: duplicate })
}

/** The first thing wrong with the draft, or null when it can be saved. */
export function draftProblem(draft: readonly DraftDimension[]): DraftProblem | null {
  if (draft.length > MAX_DIMENSIONS) return problem(PROBLEMS.tooMany.messageKey, { max: MAX_DIMENSIONS })
  // Duplicates first: with two dimensions under one key, every parent check reads the wrong one.
  const keys = draft.map((d) => d.key.trim())
  const duplicate = keys.find((key, i) => key !== '' && keys.indexOf(key) !== i)
  if (duplicate !== undefined) return problem(PROBLEMS.keyDuplicate.messageKey, { key: duplicate })
  const byKey = new Map(draft.map((d) => [d.key.trim(), d]))
  for (const dimension of draft) {
    const found = keyProblem(dimension) ?? parentProblem(dimension, byKey) ?? valuesProblem(dimension)
    if (found !== null) return found
  }
  return null
}
