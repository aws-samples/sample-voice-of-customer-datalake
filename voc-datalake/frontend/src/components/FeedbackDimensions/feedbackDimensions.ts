/**
 * @fileoverview Pure helpers behind the dimension chips and the edit control.
 * @module components/FeedbackDimensions/feedbackDimensions
 */
import { orderedDimensions, valueLabel } from '../../api/dimensionsSchema'
import type { FeedbackDimensionsChange } from '../../api/dimensionsApi'
import type { Dimension } from '../../api/dimensionsSchema'
import type { FeedbackItem } from '../../api/types'

export type EditableFeedback = Pick<FeedbackItem, 'feedback_id' | 'dimensions' | 'tags'>

/** `[key, label, value label]` for every stored dimension, configured ones first in config order. */
export function dimensionChips(
  dimensions: readonly Dimension[],
  stored: Readonly<Record<string, string>> | undefined,
): Array<{ key: string; label: string; value: string }> {
  if (stored === undefined) return []
  const configured = orderedDimensions(dimensions).flatMap((d) => {
    const value = stored[d.key]
    return value === undefined ? [] : [{ key: d.key, label: d.label, value: valueLabel(d, value) }]
  })
  const unknown = Object.entries(stored)
    .filter(([key]) => !dimensions.some((d) => d.key === key))
    .map(([key, value]) => ({ key, label: key, value }))
  return [...configured, ...unknown]
}

/** The PUT body for going from `feedback` to `next` (configured keys only); null when nothing changed. */
export function dimensionsChange(
  dimensions: readonly Dimension[],
  feedback: EditableFeedback,
  next: { dimensions: Readonly<Record<string, string>>; tags: readonly string[] },
): FeedbackDimensionsChange | null {
  const before = feedback.dimensions ?? {}
  const changed = Object.fromEntries(dimensions.flatMap((d): Array<[string, string | null]> => {
    const was = before[d.key]
    const now = next.dimensions[d.key]
    if (was === now) return []
    return [[d.key, now ?? null]]
  }))
  const tagsBefore = feedback.tags ?? []
  const tagsChanged = tagsBefore.length !== next.tags.length || tagsBefore.some((tag, i) => tag !== next.tags[i])
  const body: FeedbackDimensionsChange = {
    ...(Object.keys(changed).length === 0 ? {} : { dimensions: changed }),
    ...(tagsChanged ? { tags: [...next.tags] } : {}),
  }
  return Object.keys(body).length === 0 ? null : body
}
