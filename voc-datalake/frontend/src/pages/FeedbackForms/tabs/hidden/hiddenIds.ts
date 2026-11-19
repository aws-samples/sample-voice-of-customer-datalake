/**
 * @fileoverview A hidden field's id as you type it (UX §6): not a reserved name (`__proto__`, `constructor`,
 * `prototype`, which the widget never fills), `^[a-z][a-z0-9_]{0,39}$`, and not one the form already has. The words
 * are the problems list's (`problems.reservedHiddenId` / `problems.invalidHiddenId` / `problems.duplicateHiddenId`).
 *
 * @module pages/FeedbackForms/tabs/hidden/hiddenIds
 */
import { isReservedHiddenId, isValidHiddenId } from '../../model/codes'

export type HiddenIdProblem = 'reservedHiddenId' | 'invalidHiddenId' | 'duplicateHiddenId'

/** What is wrong with `id` as a hidden field's id (null: nothing). */
export function hiddenIdProblem(id: string, taken: ReadonlySet<string>): HiddenIdProblem | null {
  if (isReservedHiddenId(id)) return 'reservedHiddenId'
  if (!isValidHiddenId(id)) return 'invalidHiddenId'
  return taken.has(id) ? 'duplicateHiddenId' : null
}
