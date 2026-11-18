/**
 * @fileoverview A hidden field's id as you type it (UX §6): `^[a-z][a-z0-9_]{0,39}$`, and not one the form already
 * has. The words are the problems list's (`problems.invalidHiddenId` / `problems.duplicateHiddenId`).
 *
 * @module pages/FeedbackForms/tabs/hidden/hiddenIds
 */
import { isValidHiddenId } from '../../model/codes'

/** What is wrong with `id` as a hidden field's id (null: nothing). */
export function hiddenIdProblem(id: string, taken: ReadonlySet<string>): 'invalidHiddenId' | 'duplicateHiddenId' | null {
  if (!isValidHiddenId(id)) return 'invalidHiddenId'
  return taken.has(id) ? 'duplicateHiddenId' : null
}
