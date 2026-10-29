/**
 * @fileoverview The product-context form, in sections (cards): the product, its
 * customers and problem, the offering, goals and boundaries, notes. Each field saves
 * on its own (per-field autosave), and a viewer gets every field disabled at once by
 * a native `<fieldset disabled>`.
 *
 * The caps come from the assistant's `PRODUCT_CONTEXT_STRING_FIELDS`, which is
 * lockstepped with `lambda/api/product_context.py` STRING_FIELDS, so the form and
 * the server cannot disagree on a length.
 *
 * @module pages/ProjectDetail/ProductContextForm
 */
import { Compass, Layers, NotebookPen, Package, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LIFECYCLE_STATES, PRODUCT_CONTEXT_STRING_FIELDS } from '../../assistant/approvals/schemas'
import ProductCard from './ProductCard'
import { SelectField, TextAreaField, TextField } from './ProductFormFields'
import type { LucideIcon } from 'lucide-react'
import type { ProductContext, ProductLifecycleState } from '../../api/projectTypes'

type TextKey = keyof typeof PRODUCT_CONTEXT_STRING_FIELDS
type FieldKey = TextKey | 'current_state'

/** Field → its label key under `product.fields` and, for text, how many rows (0 = one-line input). */
const FIELD_UI: Readonly<Record<FieldKey, { label: string; rows: number }>> = {
  product_name: { label: 'productName', rows: 0 },
  one_liner: { label: 'oneLiner', rows: 2 },
  current_state: { label: 'currentState', rows: 0 },
  target_users: { label: 'targetUsers', rows: 3 },
  problem_solved: { label: 'problemSolved', rows: 4 },
  key_features: { label: 'keyFeatures', rows: 4 },
  differentiators: { label: 'differentiators', rows: 4 },
  success_metrics: { label: 'successMetrics', rows: 3 },
  known_limitations: { label: 'knownLimitations', rows: 3 },
  non_goals: { label: 'nonGoals', rows: 3 },
  free_form_notes: { label: 'freeFormNotes', rows: 5 },
}

/** The sections in reading order; every field appears in exactly one (the component test finds every label). */
const PRODUCT_FORM_SECTIONS: readonly { id: string; icon: LucideIcon; fields: readonly FieldKey[] }[] = [
  { id: 'basics', icon: Package, fields: ['product_name', 'one_liner', 'current_state'] },
  { id: 'customers', icon: Users, fields: ['target_users', 'problem_solved'] },
  { id: 'offering', icon: Layers, fields: ['key_features', 'differentiators'] },
  { id: 'scope', icon: Compass, fields: ['success_metrics', 'known_limitations', 'non_goals'] },
  { id: 'notes', icon: NotebookPen, fields: ['free_form_notes'] },
]

const LIFECYCLE_OPTIONS: readonly ProductLifecycleState[] = ['', ...LIFECYCLE_STATES]

function isLifecycleState(value: string): value is ProductLifecycleState {
  return LIFECYCLE_OPTIONS.some((state) => state === value)
}

function isTextKey(field: FieldKey): field is TextKey {
  return field !== 'current_state'
}

type PersistField = <K extends keyof ProductContext>(field: K, value: ProductContext[K]) => void

interface FormProps {
  readonly context: ProductContext
  /** Disables every field at once, so no field can save. */
  readonly readOnly: boolean
  readonly savingField: keyof ProductContext | null
  readonly onPersistField: PersistField
}

function ContextField({ field, context, savingField, onPersistField }: Omit<FormProps, 'readOnly'> & { readonly field: FieldKey }) {
  const { t } = useTranslation('projectDetail')
  const label = t(`product.fields.${FIELD_UI[field].label}`)
  const savingHint = savingField === field ? t('product.saving') : undefined
  if (!isTextKey(field)) {
    const options = LIFECYCLE_OPTIONS.map((value) => ({ value, label: t(`product.lifecycle.${value === '' ? 'select' : value}`) }))
    return (
      <SelectField
        label={label} value={context.current_state} options={options} savingHint={savingHint}
        onSave={(v) => { if (isLifecycleState(v)) onPersistField('current_state', v) }}
      />
    )
  }
  const common = { label, value: context[field], max: PRODUCT_CONTEXT_STRING_FIELDS[field], savingHint, onSave: (v: string) => onPersistField(field, v) }
  const rows = FIELD_UI[field].rows
  return rows === 0 ? <TextField {...common} /> : <TextAreaField {...common} rows={rows} />
}

export default function ProductContextForm({ readOnly, ...fieldProps }: FormProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-4">
      <legend className="sr-only">{t('product.title')}</legend>
      {PRODUCT_FORM_SECTIONS.map((section) => (
        <ProductCard
          key={section.id}
          icon={section.icon}
          title={t(`product.sections.${section.id}.title`)}
          description={t(`product.sections.${section.id}.description`)}
        >
          <div className="space-y-4">
            {section.fields.map((field) => <ContextField key={field} field={field} {...fieldProps} />)}
          </div>
        </ProductCard>
      ))}
    </fieldset>
  )
}
