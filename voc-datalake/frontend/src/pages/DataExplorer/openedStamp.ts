/**
 * @fileoverview The `updated_at` a processed record was opened with in the Data Explorer editor. The save
 * always sends it (`PUT /data-explorer/feedback` answers 409 when the stored record changed since), '' for a
 * record never stamped, so a record untouched since ingest is guarded too.
 *
 * @module pages/DataExplorer/openedStamp
 */

/** The record's `updated_at` as opened; '' when it has none. */
export function openedStamp(opened: unknown): string {
  if (typeof opened !== 'object' || opened === null || !('updated_at' in opened)) return ''
  return typeof opened.updated_at === 'string' ? opened.updated_at : ''
}
