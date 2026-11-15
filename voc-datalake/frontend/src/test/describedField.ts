/**
 * @fileoverview A form field's state as a screen reader has it: whether it is invalid, and the text that describes it
 * (its hint, or what is wrong with it), found by its label inside a dialog. Shared by the dialogs' tests.
 */
import { within } from '@testing-library/react'

export function said(dialog: HTMLElement, label: string): [string | null, string | null | undefined] {
  const field = within(dialog).getByLabelText(label)
  return [field.getAttribute('aria-invalid'), document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent]
}
