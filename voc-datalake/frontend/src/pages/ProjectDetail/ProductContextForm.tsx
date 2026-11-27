/**
 * @fileoverview The product-context form, in sections (cards): the product, its
 * customers and problem, the offering, goals and boundaries, notes. Each field saves
 * on its own (per-field autosave), and a viewer gets every field disabled at once by
 * a native `<fieldset disabled>`.
 *
 * The caps come from the assistant's `PRODUCT_CONTEXT_STRING_FIELDS`, which is
 * lockstepped with `lambda/shared/product_fields.py` STRING_FIELDS (pinned by
 * `lambda/shared/test/test_product_fields.py`), so the form and the server cannot
 * disagree on a length.
 *
 * @module pages/ProjectDetail/ProductContextForm
 */
import { Compass, Layers, NotebookPen, Package, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LIFECYCLE_STATES, PRODUCT_CONTEXT_STRING_FIELDS } from '@stream/assistant/tools/client/allowlists'
import ProductCard from './ProductCard'
import { SelectField, TextAreaField, TextField } from './ProductFormFields'
import { proposalRowId } from './productProposalModel'
import { productFieldLabelKey } from './productContextFields'
import type { LucideIcon } from 'lucide-react'
import type { ProductContext, ProductLifecycleState } from '../../api/projectTypes'

type TextKey = keyof typeof PRODUCT_CONTEXT_STRING_FIELDS
type FieldKey = TextKey | 'current_state'

/** Field → how many rows its control has (0 = a one-line input); its label is `productFieldLabelKey`'s. */
const FIELD_ROWS: Readonly<Record<FieldKey, number>> = {
  product_summary: 5,
  product_name: 0,
  one_liner: 2,
  current_state: 0,
  target_users: 3,
  problem_solved: 4,
  key_features: 4,
  differentiators: 4,
  success_metrics: 3,
  known_limitations: 3,
  non_goals: 3,
  free_form_notes: 5,
}

/** The sections in reading order; every field appears in exactly one (the component test finds every label). */
const PRODUCT_FORM_SECTIONS: readonly { id: string; icon: LucideIcon; fields: readonly FieldKey[] }[] = [
  { id: 'basics', icon: Package, fields: ['product_summary', 'product_name', 'one_liner', 'current_state'] },
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
  /** The fields an open proposal proposes a value for: each shows a "Proposed" badge that scrolls to its review row. */
  readonly proposedFields?: ReadonlySet<FieldKey>
}

function ProposedBadge({ field, label }: Readonly<{ field: FieldKey; label: string }>) {
  const { t } = useTranslation('projectDetail')
  // A 24 x 24 px target at least (WCAG 2.5.8), apart from the field's label.
  return (
    <button type="button" className="badge badge-accent float-right ml-2 min-h-6 min-w-6 justify-center"
      aria-label={t('product.review.proposedBadgeLabel', { field: label })}
      onClick={() => document.getElementById(proposalRowId(field))?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
      {t('product.review.proposedBadge')}
    </button>
  )
}

function ContextControl({ field, context, savingField, onPersistField }: Omit<FormProps, 'readOnly' | 'proposedFields'> & { readonly field: FieldKey }) {
  const { t } = useTranslation('projectDetail')
  const label = t(productFieldLabelKey(field))
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
  const rows = FIELD_ROWS[field]
  return rows === 0 ? <TextField {...common} /> : <TextAreaField {...common} rows={rows} />
}

/** One field: always the same wrapper, the badge in or out of its own slot, so the control is never remounted when a
 * proposal arrives or goes (a remount would drop an unsaved draft, which saves on blur, and the focus). */
function ContextField({ proposedFields, ...props }: Omit<FormProps, 'readOnly'> & { readonly field: FieldKey }) {
  const { t } = useTranslation('projectDetail')
  const proposed = proposedFields?.has(props.field) === true
  return (
    <div>
      {proposed ? <ProposedBadge field={props.field} label={t(productFieldLabelKey(props.field))} /> : null}
      <ContextControl {...props} />
    </div>
  )
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
