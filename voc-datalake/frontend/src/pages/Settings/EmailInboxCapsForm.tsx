/**
 * @fileoverview The email inbox's daily caps (admin): overall emails, emails per sender,
 * and model calls (the daily model budget). Bounds mirror CAP_BOUNDS in
 * `lambda/shared/email_intake_settings.py`; the server re-checks them.
 * @module pages/Settings/EmailInboxCapsForm
 */
import { useState } from 'react'
import type { SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Save } from 'lucide-react'
import { CAP_BOUNDS, CAP_KEYS, emailInboxApi, emailInboxKey } from '../../api/emailInboxApi'
import type { CapKey, EmailInboxCaps } from '../../api/emailInboxApi'

function inBounds(key: CapKey, value: number): boolean {
  const { min, max } = CAP_BOUNDS[key]
  return Number.isInteger(value) && value >= min && value <= max
}

function draftValid(draft: Record<CapKey, string>): boolean {
  return CAP_KEYS.every((key) => draft[key].trim() !== '' && inBounds(key, Number(draft[key])))
}

function toDraft(caps: EmailInboxCaps): Record<CapKey, string> {
  return { daily_cap: String(caps.daily_cap), sender_daily_cap: String(caps.sender_daily_cap),
    daily_model_calls: String(caps.daily_model_calls) }
}

function toCaps(draft: Record<CapKey, string>): EmailInboxCaps {
  return { daily_cap: Number(draft.daily_cap), sender_daily_cap: Number(draft.sender_daily_cap),
    daily_model_calls: Number(draft.daily_model_calls) }
}

interface CapFieldProps {
  readonly capKey: CapKey
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}

function CapField({ capKey, value, disabled, onChange }: CapFieldProps) {
  const { t } = useTranslation('emailInbox')
  const { min, max } = CAP_BOUNDS[capKey]
  const id = `email-inbox-cap-${capKey}`
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text">{t(`caps.${capKey}`)}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className="input w-full"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs text-muted">{t('caps.range', { min, max })}</p>
    </div>
  )
}

export default function EmailInboxCapsForm({ caps }: { readonly caps: EmailInboxCaps }) {
  const { t } = useTranslation('emailInbox')
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => toDraft(caps))
  const save = useMutation({
    mutationFn: (next: EmailInboxCaps) => emailInboxApi.saveCaps(next),
    onSuccess: (status) => queryClient.setQueryData(emailInboxKey(), status),
  })
  const valid = draftValid(draft)

  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    if (valid) save.mutate(toCaps(draft))
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-labelledby="email-inbox-caps-title">
      <h4 id="email-inbox-caps-title" className="text-sm font-medium text-text">{t('caps.title')}</h4>
      <div className="grid gap-3 sm:grid-cols-3">
        {CAP_KEYS.map((key) => (
          <CapField
            key={key}
            capKey={key}
            value={draft[key]}
            disabled={save.isPending}
            onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
          />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-secondary btn-sm flex items-center gap-1.5" disabled={!valid || save.isPending}>
          {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
          {t('caps.save')}
        </button>
        {save.isSuccess && <span role="status" className="text-sm text-ok">{t('caps.saved')}</span>}
        {save.isError && <span role="alert" className="text-sm text-danger">{t('errors.save')}</span>}
      </div>
    </form>
  )
}
