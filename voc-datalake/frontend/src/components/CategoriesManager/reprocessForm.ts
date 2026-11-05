/**
 * @fileoverview The reprocess panel's form state → the `POST /settings/categories/reprocess` body.
 *
 * Pure, so the rules the server enforces (days XOR a date range, `date_from` not after
 * `date_to`, at most 50 values per axis) are refused here first and can be tested alone.
 * The server re-checks every one of them (lambda/shared/reprocess_slices.py).
 *
 * @module components/CategoriesManager/reprocessForm
 */
import { parseCustomDaysInput } from '../../api/baseUrl'
import { MAX_SLICE_VALUES } from '../../api/reprocessApi'
import type { ReprocessDateBasis, ReprocessMode, ReprocessStart, ReprocessWindow } from '../../api/reprocessApi'

export type WindowKind = 'days' | 'range'

export interface ReprocessForm {
  mode: ReprocessMode
  includeManual: boolean
  windowKind: WindowKind
  daysInput: string
  dateFrom: string
  dateTo: string
  dateBasis: ReprocessDateBasis
  sources: readonly string[]
  categoriesInput: string
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A comma-separated list: trimmed, blanks dropped, duplicates removed in order. */
export function parseList(input: string): string[] {
  return [...new Set(input.split(',').map((value) => value.trim()).filter((value) => value !== ''))]
}

function rangeIsValid(from: string, to: string): boolean {
  if (from !== '' && !ISO_DAY.test(from)) return false
  if (to !== '' && !ISO_DAY.test(to)) return false
  return from === '' || to === '' || from <= to
}

/** The window a valid form names, or null (an unreadable day count, an empty or inverted range). */
export function windowOf(form: ReprocessForm): ReprocessWindow | null {
  if (form.windowKind === 'days') {
    const days = parseCustomDaysInput(form.daysInput)
    return days === null ? null : { days }
  }
  if ((form.dateFrom === '' && form.dateTo === '') || !rangeIsValid(form.dateFrom, form.dateTo)) return null
  return {
    ...(form.dateFrom === '' ? {} : { date_from: form.dateFrom }),
    ...(form.dateTo === '' ? {} : { date_to: form.dateTo }),
    date_basis: form.dateBasis,
  }
}

/** The start body, or null while the form is not valid (the Start button stays disabled). */
export function buildStart(form: ReprocessForm): ReprocessStart | null {
  const categories = parseList(form.categoriesInput)
  if (categories.length > MAX_SLICE_VALUES || form.sources.length > MAX_SLICE_VALUES) return null
  const window = windowOf(form)
  if (window === null) return null
  return {
    mode: form.mode,
    include_manual: form.includeManual,
    ...(form.sources.length > 0 ? { sources: [...form.sources] } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...window,
  }
}
