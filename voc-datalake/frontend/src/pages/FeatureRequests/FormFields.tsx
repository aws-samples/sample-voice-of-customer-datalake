/**
 * @fileoverview The board forms' labelled text field (one line or several) with its error under it.
 *
 * @module pages/FeatureRequests/FormFields
 */
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../../components/LabeledField/LabeledField'

/** A field's error as its translated sentence; nothing when `messageKey` is undefined. */
export function FieldError({ messageKey }: Readonly<{ messageKey: string | undefined }>) {
  const { t } = useTranslation('featureRequests')
  return messageKey === undefined ? null : <p role="alert" className="text-[12px] text-danger">{t(messageKey)}</p>
}

/** `rows` makes it a textarea; `error` is a `featureRequests:` message key; `hint` shows under it. */
export function TextField({ label, value, maxLength, error, hint, type = 'text', rows, onChange }: Readonly<{
  label: string; value: string; maxLength: number; error?: string; hint?: string; type?: 'text' | 'email' | 'url'; rows?: number
  onChange: (value: string) => void
}>) {
  return (
    <LabeledField label={label} hint={hint}>
      {(id) => (
        <>
          {rows === undefined ? (
            <input id={id} type={type} className="input w-full" value={value} maxLength={maxLength}
              aria-invalid={error !== undefined} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <textarea id={id} rows={rows} className="input w-full" value={value} maxLength={maxLength}
              aria-invalid={error !== undefined} onChange={(e) => onChange(e.target.value)} />
          )}
          <FieldError messageKey={error} />
        </>
      )}
    </LabeledField>
  )
}

/** A labelled select over a fixed set of values, each shown by its translated label. */
export function ChoiceField<T extends string>({ label, value, choices, labels, fullWidth = false, onChange }: Readonly<{
  label: string
  value: T
  choices: readonly T[]
  labels: Readonly<Record<T, { labelKey: string }>>
  fullWidth?: boolean
  onChange: (value: T) => void
}>) {
  const { t } = useTranslation('featureRequests')
  return (
    <LabeledField label={label}>
      {(id) => (
        <select id={id} className={fullWidth ? 'select w-full' : 'select w-auto'} value={value}
          onChange={(e) => {
            const chosen = choices.find((choice) => choice === e.target.value)
            if (chosen !== undefined) onChange(chosen)
          }}>
          {choices.map((choice) => <option key={choice} value={choice}>{t(labels[choice].labelKey)}</option>)}
        </select>
      )}
    </LabeledField>
  )
}
