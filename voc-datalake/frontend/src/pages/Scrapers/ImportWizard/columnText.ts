/**
 * @fileoverview A detected column's words in the reader's language: its kind's name and the detection's reasons
 * (lambda/shared/import_detect.py: each a code with parameters, `importWizard.reasons.<code>`).
 *
 * @module pages/Scrapers/ImportWizard/columnText
 */
import type { TFunction } from 'i18next'
import type { ColumnKind, DetectedColumn } from '../../../api/importWizardSchema'

/** A kind's name (`importWizard.kinds.<kind>`). */
export function columnKindLabel(t: TFunction, kind: ColumnKind): string {
  return t(`importWizard.kinds.${kind}`)
}

/** The detection's reasons, one sentence (a reason this release does not know reads as its code). */
export function reasonsText(t: TFunction, column: DetectedColumn): string {
  return column.reasons.map((reason) => t(`importWizard.reasons.${reason.code}`, { ...reason.params,
    defaultValue: reason.code })).join(', ')
}
