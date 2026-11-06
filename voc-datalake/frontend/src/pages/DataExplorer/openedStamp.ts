/**
 * @fileoverview The `updated_at` a processed record was opened with in the Data Explorer editor. The save
 * always sends it (`PUT /data-explorer/feedback` answers 409 when the stored record changed since), '' for a
 * record never stamped, so a record untouched since ingest is guarded too. The edited JSON is passed on as it
 * is: the API validates every field (`shared/feedback_field_edits.py`), this module checks no shape.
 *
 * @module pages/DataExplorer/openedStamp
 */

import type { FeedbackItem } from '../../api/types'

/** The record's `updated_at` as opened; '' when it has none. */
export function openedStamp(opened: unknown): string {
  if (typeof opened !== 'object' || opened === null || !('updated_at' in opened)) return ''
  return typeof opened.updated_at === 'string' ? opened.updated_at : ''
}

/**
 * The body of a processed-record save: the edited JSON (an object; anything else saves nothing) with the
 * `updated_at` the record was OPENED with, whatever the JSON now says, so the API can refuse a stale editor.
 */
export function savedFeedbackBody(edited: unknown, opened: unknown): Partial<FeedbackItem> & { updated_at: string } {
  const fields = typeof edited === 'object' && edited !== null ? edited : {}
  return { ...fields, updated_at: openedStamp(opened) }
}
