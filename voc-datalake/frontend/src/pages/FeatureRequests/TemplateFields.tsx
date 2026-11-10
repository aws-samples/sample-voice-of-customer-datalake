/**
 * @fileoverview The board's template fields on "New request" (`kind`, `severity`, `steps`, …), each
 * as its catalogue type asks: a select for a choice, a number input, a text or a long text. A
 * required field says so in its label; an optional choice can stay "Not set".
 *
 * @module pages/FeatureRequests/TemplateFields
 */
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { FIELD_SPECS, isRequired } from '../../api/boardFields'
import type { BoardFields, FieldKey, FieldSpec } from '../../api/boardFields'
import { FieldError, TextField } from './FormFields'
import { CHOICE_LABELS } from './boardLabels'
import { useFieldLabel } from './useFieldLabel'
import { templateKeysOf } from './templateDraft'
import type { TemplateDraft, TemplateErrors } from './templateDraft'

/** The words of one choice of `key` (a rating is its digit). */
function useChoiceLabel(): (key: FieldKey, choice: string) => string {
  const { t } = useTranslation('featureRequests')
  return (key, choice) => {
    const labelKey = CHOICE_LABELS[`${key}.${choice}`]?.labelKey
    return labelKey === undefined ? choice : t(labelKey)
  }
}

/** A whole-number field this small (the 1-5 rating) is a select of its values. */
const MAX_SELECT_NUMBER = 10
/** RFC 5321's longest address. */
const EMAIL_MAX = 254

function ChoiceInput({ fieldKey, choices, label, value, required, error, onChange }: Readonly<{
  fieldKey: FieldKey; choices: readonly string[]; label: string; value: string; required: boolean; error?: string
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const choiceLabel = useChoiceLabel()
  return (
    <LabeledField label={label}>
      {(id) => (
        <>
          <select id={id} className="select w-full" value={value} aria-required={required} aria-invalid={error !== undefined}
            onChange={(e) => onChange(e.target.value)}>
            <option value="">{required ? t('form.choose') : t('form.notSet')}</option>
            {choices.map((choice) => <option key={choice} value={choice}>{choiceLabel(fieldKey, choice)}</option>)}
          </select>
          <FieldError messageKey={error} />
        </>
      )}
    </LabeledField>
  )
}

function NumberInput({ label, value, error, required, onChange }: Readonly<{
  label: string; value: string; error?: string; required: boolean; onChange: (value: string) => void
}>) {
  return (
    <LabeledField label={label}>
      {(id) => (
        <>
          <input id={id} inputMode="numeric" className="input w-full" value={value} aria-required={required}
            aria-invalid={error !== undefined} onChange={(e) => onChange(e.target.value.replaceAll(/\D/g, '').slice(0, 10))} />
          <FieldError messageKey={error} />
        </>
      )}
    </LabeledField>
  )
}

function CatalogueInput({ fieldKey, spec, required, value, error, onChange }: Readonly<{
  fieldKey: FieldKey; spec: FieldSpec; required: boolean; value: string; error?: string; onChange: (value: string) => void
}>) {
  const label = useFieldLabel()(fieldKey, required)
  if (spec.type === 'choice') {
    return <ChoiceInput fieldKey={fieldKey} choices={spec.choices} label={label} value={value} required={required} error={error} onChange={onChange} />
  }
  if (spec.type === 'int' && spec.max <= MAX_SELECT_NUMBER) {
    const choices = Array.from({ length: spec.max - spec.min + 1 }, (_, index) => String(spec.min + index))
    return <ChoiceInput fieldKey={fieldKey} choices={choices} label={label} value={value} required={required} error={error} onChange={onChange} />
  }
  if (spec.type === 'int') return <NumberInput label={label} value={value} error={error} required={required} onChange={onChange} />
  if (spec.type === 'email') return <TextField label={label} type="email" value={value} maxLength={EMAIL_MAX} error={error} onChange={onChange} />
  return (
    <TextField label={label} value={value} maxLength={spec.max} error={error} rows={spec.type === 'longtext' ? 4 : undefined}
      type={spec.type === 'url' ? 'url' : 'text'} onChange={onChange} />
  )
}

/** Every enabled template field of `fields`, wide ones (long text) across both columns. */
export default function TemplateFields({ fields, draft, errors, onChange }: Readonly<{
  fields: BoardFields
  draft: TemplateDraft
  errors: TemplateErrors
  onChange: (draft: TemplateDraft) => void
}>) {
  const keys = templateKeysOf(fields)
  if (keys.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {keys.map((key) => {
        const spec: FieldSpec = FIELD_SPECS[key]
        return (
          <div key={key} className={spec.type === 'longtext' ? 'sm:col-span-2' : undefined}>
            <CatalogueInput fieldKey={key} spec={spec} required={isRequired(fields.request, key)} value={draft[key] ?? ''} error={errors[key]}
              onChange={(value) => onChange({ ...draft, [key]: value })} />
          </div>
        )
      })}
    </div>
  )
}
