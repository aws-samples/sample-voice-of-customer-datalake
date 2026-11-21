/**
 * @fileoverview The Validation tab's pure parts (7.68.00): the editors' rows to and from the wire, the card's language,
 * and the decision prefill as the Decisions tab's deep link. Kept out of the components so each is tested alone.
 * @module pages/ProjectDetail/validation/validationModel
 */
import { isSupportedLanguage } from '../../../i18n/languages'
import { decisionDeepLink } from '../decisions/decisionDraft'
import type { SupportedLanguage } from '../../../i18n/languages'
import type {
  CriterionInput, DecisionPrefill, TaskInput, ValidationCriterion, ValidationTask,
} from '../../../api/validationApi'

/** One editable row: its saved id (none before the first save), its text and, for a criterion, its target. */
export interface EditorRow {
  readonly key: string
  readonly id?: string
  readonly text: string
  readonly target: string
}

/** The bounds the server holds (shared/project_validation.py). */
export const LIMITS = { criteria: 10, tasks: 8, textChars: 300, minTarget: 1, maxTarget: 5 } as const

/** A fresh row for "Add" (its key only tells React the rows apart; the server mints the id). */
export function newRow(): EditorRow {
  return { key: `new-${crypto.randomUUID()}`, text: '', target: '' }
}

export function criteriaRows(criteria: readonly ValidationCriterion[]): EditorRow[] {
  return criteria.map((criterion) => ({
    key: criterion.id, id: criterion.id, text: criterion.text,
    target: criterion.target === undefined ? '' : String(criterion.target),
  }))
}

export function taskRows(tasks: readonly ValidationTask[]): EditorRow[] {
  return tasks.map((task) => ({ key: task.id, id: task.id, text: task.text, target: '' }))
}

/** A target the server takes (1 to 5), or undefined for none (blank) or one it would refuse. */
export function parsedTarget(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= LIMITS.minTarget && number <= LIMITS.maxTarget ? number : undefined
}

/** True when every row has text and every target is blank or 1 to 5. */
export function rowsValid(rows: readonly EditorRow[], withTarget: boolean): boolean {
  return rows.length > 0 && rows.every((row) => row.text.trim() !== ''
    && (!withTarget || row.target.trim() === '' || parsedTarget(row.target) !== undefined))
}

export function toCriteria(rows: readonly EditorRow[]): CriterionInput[] {
  return rows.map((row) => {
    const target = parsedTarget(row.target)
    return { ...(row.id === undefined ? {} : { id: row.id }), text: row.text.trim(),
      ...(target === undefined ? {} : { target }) }
  })
}

export function toTasks(rows: readonly EditorRow[]): TaskInput[] {
  return rows.map((row) => ({ ...(row.id === undefined ? {} : { id: row.id }), text: row.text.trim() }))
}

/** The card's language and the AI's: the page's, when it is one of the nine, else English. */
export function cardLanguage(language: string): SupportedLanguage {
  const base = language.split('-')[0] ?? ''
  return isSupportedLanguage(base) ? base : 'en'
}

/** A rate (0 to 1) as a whole percent, or null without answers. */
export function percent(rate: number | null): number | null {
  return rate === null ? null : Math.round(rate * 100)
}

/** The Decisions tab's link with the decision the report suggests (nothing is saved until the person saves it). */
export function decisionLink(projectId: string, prefill: DecisionPrefill): string {
  return decisionDeepLink(projectId, {
    title: prefill.title, verdict: prefill.verdict, rationale: prefill.rationale,
    successMetric: prefill.success_metric, documentIds: prefill.evidence.document_ids,
    feedbackIds: prefill.evidence.feedback_ids,
  })
}
