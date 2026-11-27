/**
 * @fileoverview What every editable line of a question's list shares (an option of a choice, a row or a column of a
 * matrix): its place, its label and code, whether codes show or are locked, its problems, and its edits.
 *
 * @module pages/FeedbackForms/questions/listRowProps
 */
import type { Ref } from 'react'
import type { FormProblem } from '../model/validateForm'

export interface ListRowProps {
  readonly index: number
  readonly total: number
  readonly label: string
  readonly code: string
  /** Every other code of the same list (a hand-typed code must not repeat one). */
  readonly otherCodes: readonly string[]
  readonly locked: boolean
  readonly showCodes: boolean
  readonly problems: readonly FormProblem[]
  readonly inputRef: Ref<HTMLInputElement>
  readonly onLabel: (value: string) => void
  readonly onCode: (value: string) => void
  /** Enter in the label: a new line below. */
  readonly onEnter: () => void
  readonly onMove: (to: number) => void
  readonly onDelete: () => void
}
