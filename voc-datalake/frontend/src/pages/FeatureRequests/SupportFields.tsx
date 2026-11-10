/**
 * @fileoverview The fields a supporter fills in — the board's enabled support fields (customer,
 * deal, revenue impact, amount in USD, contact email, note) and always their own name — shared by
 * "New request", "+1" and "Edit my support".
 *
 * @module pages/FeatureRequests/SupportFields
 */
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { IMPACT_CHOICES, isRequired } from '../../api/boardFields'
import { formatCount } from '../../utils/numberFormat'
import { SUPPORT_LIMITS, amountDigits, asksAmount, formatUsd } from './boardFormat'
import { ChoiceField, FieldError, TextField } from './FormFields'
import { useFieldLabel } from './useFieldLabel'
import type { SupportDraft, SupportErrors, SupportSpec } from './boardFormat'
import { FIELD_LABELS, IMPACT_LABELS } from './boardLabels'

function AmountField({ draft, error, onChange }: Readonly<{
  draft: SupportDraft; error?: string; onChange: (amount: string) => void
}>) {
  const { t, i18n } = useTranslation('featureRequests')
  const shown = draft.amount === '' ? '' : formatCount(Number(draft.amount), i18n.language)
  return (
    <LabeledField label={t(FIELD_LABELS.amount_usd.labelKey)}
      hint={draft.amount === '' ? t('form.amountHint') : formatUsd(Number(draft.amount), i18n.language)}>
      {(id) => (
        <>
          <input id={id} inputMode="numeric" className="input w-full" value={shown} aria-invalid={error !== undefined}
            onChange={(e) => onChange(amountDigits(e.target.value))} />
          <FieldError messageKey={error} />
        </>
      )}
    </LabeledField>
  )
}

/** The revenue impact and, when it asks for one, the amount (a note in its place otherwise). */
function ImpactFields({ draft, spec, error, set }: Readonly<{
  draft: SupportDraft; spec: SupportSpec; error?: string
  set: <K extends keyof SupportDraft>(key: K) => (value: SupportDraft[K]) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const label = useFieldLabel()
  const hasImpact = spec.keys.includes('impact')
  return (
    <>
      {hasImpact ? (
        <ChoiceField label={label('impact', isRequired(spec.fields, 'impact'))} value={draft.impact} choices={IMPACT_CHOICES}
          labels={IMPACT_LABELS} fullWidth onChange={set('impact')} />
      ) : null}
      {asksAmount(draft, spec) ? <AmountField draft={draft} error={error} onChange={set('amount')} /> : null}
      {hasImpact && spec.keys.includes('amount_usd') && draft.impact === 'none' ? (
        <p className="text-[12px] text-muted self-end">{t('form.noAmount')}</p>
      ) : null}
    </>
  )
}

/** The board's support fields of `draft` (`spec`); `errors` (message keys) shown under their fields. */
export default function SupportFields({ draft, errors, spec, onChange }: Readonly<{
  draft: SupportDraft
  errors: SupportErrors
  spec: SupportSpec
  onChange: (draft: SupportDraft) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const label = useFieldLabel()
  const has = (key: SupportSpec['keys'][number]) => spec.keys.includes(key)
  const required = (key: SupportSpec['keys'][number]) => isRequired(spec.fields, key)
  const set = <K extends keyof SupportDraft>(key: K) => (value: SupportDraft[K]) => onChange({ ...draft, [key]: value })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {has('customer') ? (
        <TextField label={label('customer', required('customer'))} value={draft.customer} maxLength={SUPPORT_LIMITS.customer}
          error={errors.customer} onChange={set('customer')} />
      ) : null}
      {has('deal') ? (
        <TextField label={label('deal', required('deal'))} value={draft.deal} maxLength={SUPPORT_LIMITS.deal} onChange={set('deal')} />
      ) : null}
      <ImpactFields draft={draft} spec={spec} error={errors.amount} set={set} />
      {has('contact_email') ? (
        <TextField label={label('contact_email', required('contact_email'))} type="email" value={draft.contactEmail}
          maxLength={SUPPORT_LIMITS.contactEmail} error={errors.contactEmail} onChange={set('contactEmail')} />
      ) : null}
      <TextField label={t('form.name')} value={draft.name} maxLength={SUPPORT_LIMITS.name} error={errors.name} onChange={set('name')} />
      {has('note') ? (
        <div className="sm:col-span-2">
          <TextField label={label('note', required('note'))} rows={2} value={draft.note} maxLength={SUPPORT_LIMITS.note} onChange={set('note')} />
        </div>
      ) : null}
    </div>
  )
}
