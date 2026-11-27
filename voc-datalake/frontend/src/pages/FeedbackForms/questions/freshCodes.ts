/**
 * @fileoverview The draft's fresh codes (`freshCodes`) as a line's label and code are edited: a new option's, row's or
 * column's code follows its label until the form is saved, and stops following it once typed by hand (UX §4.1). One
 * set of rules for the choice editor and the matrix editor; `keyOf` names a line's key in the set.
 *
 * @module pages/FeedbackForms/questions/freshCodes
 */
import type { FormDraft } from '../builder/formDraftContext'

type FreshCodes = Pick<FormDraft, 'freshCodes' | 'setFreshCodes'>

/**
 * A label edit of the line coded `code` (undefined: no such line): `relabel` writes it, told whether the code is
 * still fresh, and answers the code the line has now; a fresh code that moved keeps its mark.
 */
export function followLabel(draft: FreshCodes, keyOf: (code: string) => string, code: string | undefined,
  relabel: (code: string, fresh: boolean) => string): void {
  if (code === undefined) return
  const next = relabel(code, draft.freshCodes.has(keyOf(code)))
  if (next !== code) draft.setFreshCodes((keys) => new Set([...[...keys].filter((key) => key !== keyOf(code)), keyOf(next)]))
}

/** A code typed by hand for the line coded `code` (undefined: no such line): `rename` writes it, and it stops
 * following its label. */
export function typedCode(draft: FreshCodes, keyOf: (code: string) => string, code: string | undefined, rename: (code: string) => void): void {
  if (code === undefined) return
  rename(code)
  draft.setFreshCodes((keys) => new Set([...keys].filter((key) => key !== keyOf(code))))
}
