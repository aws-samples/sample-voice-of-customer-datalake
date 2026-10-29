/**
 * @fileoverview The template fields of "New request" — every enabled request field that is not a
 * customer-and-revenue field (those are SupportFields'): `kind`, `severity`, `reference`, `steps`,
 * `affected_count`, `area`, `outcome`, `rating`, `link`. The draft as typed, its validation
 * (api/boardFields.ts) and the `fields` values it sends.
 *
 * @module pages/FeatureRequests/templateFields
 */
import { LEVEL_FIELD_KEYS, enabledFields, fieldError, isDescriptionRequired, isNumericField, isRequired } from '../../api/boardFields'
import type { BoardFields, BoardTemplate, FieldKey } from '../../api/boardFields'
import type { FieldValues } from '../../api/featureBoardsSchema'
import { DESCRIPTION_REQUIRED_ERRORS, FIELD_ERROR_LABELS } from './boardLabels'
import { SUPPORT_FORM_KEYS } from './boardFormat'

export type TemplateDraft = Readonly<Partial<Record<FieldKey, string>>>
export type TemplateErrors = Readonly<Partial<Record<FieldKey, string>>>

const TEMPLATE_KEYS: readonly FieldKey[] = LEVEL_FIELD_KEYS.request.filter((key) => !SUPPORT_FORM_KEYS.request.includes(key))

/** The template fields the board's "New request" shows, in form order. */
export function templateKeysOf(fields: BoardFields): FieldKey[] {
  return enabledFields(fields.request, TEMPLATE_KEYS)
}

/** Error message keys by field; empty = valid. */
export function validateTemplateFields(draft: TemplateDraft, fields: BoardFields): TemplateErrors {
  const errors: Partial<Record<FieldKey, string>> = {}
  for (const key of templateKeysOf(fields)) {
    const code = fieldError(key, draft[key] ?? '', isRequired(fields.request, key))
    if (code !== undefined) errors[key] = FIELD_ERROR_LABELS[code].messageKey
  }
  return errors
}

/** The template values of a valid draft (empty ones left out). */
export function templateValuesOf(draft: TemplateDraft, fields: BoardFields): FieldValues {
  const keys = templateKeysOf(fields)
  const values: Partial<Record<FieldKey, string | number>> = {}
  for (const key of keys) {
    const value = (draft[key] ?? '').trim()
    if (value !== '') values[key] = isNumericField(key) ? Number(value) : value
  }
  return values
}

/** The message key an empty description is refused with on `template`, or undefined when it is fine. */
export function descriptionError(description: string, template: BoardTemplate): string | undefined {
  if (description.trim() !== '' || !isDescriptionRequired(template)) return undefined
  return DESCRIPTION_REQUIRED_ERRORS[template].messageKey
}
