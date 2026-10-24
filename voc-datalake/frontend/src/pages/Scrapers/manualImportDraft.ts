/**
 * @fileoverview The manual-import draft kept in localStorage (`voc-manual-import`).
 *
 * Live finding: a pasted text over the limit was saved as the draft and
 * reopened on every visit, already refused, with no way to start over. Opening
 * the dialog now drops such a draft (`setIsModalOpen`, store/manualImportStore)
 * and the input step offers "Clear draft" whenever there is a draft.
 *
 * @module pages/Scrapers/manualImportDraft
 */

/** True when the dialog has a draft worth offering to clear. */
export function hasDraft(state: Readonly<{ sourceUrl: string; rawText: string; parsedReviews: readonly unknown[] }>): boolean {
  return state.sourceUrl !== '' || state.rawText !== '' || state.parsedReviews.length > 0
}
