/**
 * @fileoverview One theme colour (audit §2.2): a real swatch control (`<input type="color">` with the
 * `--control-border` edge, so even a dark swatch on a dark card has a 3:1 boundary) beside its hex field, validated as
 * it is typed (`#rgb` or `#rrggbb`) with the reason in words. Only a valid value reaches the draft: what the field
 * holds meanwhile stays the person's, until a preset, a suggestion or a reset sets the colour.
 *
 * The colour itself is the customer's form data (the design system's out-of-scope colours).
 *
 * @module pages/FeedbackForms/theme/ColourField
 */
import { useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleX } from 'lucide-react'
import clsx from 'clsx'
import { isEditorHex } from './contrast'

/** `#rgb` or `#rrggbb(aa)` as the swatch control's `#rrggbb` (it takes nothing else). */
function swatchValue(colour: string): string {
  const value = colour.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(value)) return value.replace(/[0-9a-f]/g, '$&$&')
  return /^#[0-9a-f]{6}/.test(value) ? value.slice(0, 7) : '#000000'
}

export default function ColourField({ label, hint, value, onChange, describedBy }: Readonly<{
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  /** The ids of the contrast notes about this colour. */
  describedBy?: string
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  // What is typed, for the colour it was typed over: a new colour from elsewhere replaces it.
  const [typed, setTyped] = useState<{ readonly text: string; readonly over: string } | null>(null)
  const text = typed !== null && typed.over === value ? typed.text : value
  const valid = isEditorHex(text) || text === value
  const type = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value
    if (isEditorHex(next)) {
      setTyped(null)
      onChange(next.trim())
    } else {
      setTyped({ text: next, over: value })
    }
  }
  const described = [hint === undefined ? '' : `${id}-hint`, valid ? '' : `${id}-error`, describedBy ?? ''].filter(Boolean).join(' ')
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={swatchValue(value)} aria-label={t('theme.colours.swatch', { label })}
          onChange={(event) => { setTyped(null); onChange(event.target.value) }}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-control-border bg-bg-elevated p-0.5 hover:border-control-border-hover focus-ring" />
        <input id={id} type="text" value={text} onChange={type} spellCheck={false} autoComplete="off" maxLength={9}
          aria-invalid={valid ? undefined : true} aria-describedby={described === '' ? undefined : described}
          className={clsx('input min-w-0 flex-1 font-mono', !valid && 'border-danger')} />
      </div>
      {hint !== undefined && <p id={`${id}-hint`} className="mt-1 text-[12px] text-muted">{hint}</p>}
      {!valid && (
        <p id={`${id}-error`} className="mt-1 flex items-center gap-1.5 text-[12px] text-danger">
          <CircleX size={14} aria-hidden="true" className="shrink-0" />{t('theme.colours.invalid')}
        </p>
      )}
    </div>
  )
}
