/**
 * @fileoverview Settings › Theme (UX §14.1): the widget's four theme values (the customer's own colours, rendered on
 * their page: data, not app tokens), shown live by the builder's preview. Under the text colour, a warning when the
 * text on the background is under 4.5:1.
 *
 * @module pages/FeedbackForms/tabs/settings/ThemeSection
 */
import { useId } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { useDraft } from '../../builder/formDraftContext'
import type { FormTheme } from '../../model/formsV2'
import { formatDecimal } from '../../../../utils/numberFormat'
import { MIN_TEXT_CONTRAST, contrastRatio } from './contrast'

function ColorField({ label, value, onChange, children }: Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
  children?: ReactNode
}>) {
  const id = useId()
  const change = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">{label}</label>
      <div className="flex items-center gap-2">
        <input id={id} type="color" value={value} onChange={change}
          className="h-10 w-10 flex-shrink-0 cursor-pointer rounded-sm border border-border bg-bg-elevated focus-ring" />
        <input aria-label={label} type="text" value={value} onChange={change} className="input min-w-0 flex-1 font-mono" />
      </div>
      {children}
    </div>
  )
}

function ContrastWarning({ theme }: Readonly<{ theme: FormTheme }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const ratio = contrastRatio(theme.text_color, theme.background_color)
  if (ratio === null || ratio >= MIN_TEXT_CONTRAST) return null
  return (
    <p role="note" className="mt-1 flex items-start gap-1.5 text-[12px] text-warn">
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      {t('settings.theme.lowContrast', { ratio: formatDecimal(ratio, i18n.language, 1) })}
    </p>
  )
}

export default function ThemeSection() {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const radiusId = useId()
  const set = (patch: Partial<FormTheme>) => update((current) => ({ ...current, theme: { ...current.theme, ...patch } }))
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ColorField label={t('settings.theme.primary')} value={form.theme.primary_color} onChange={(value) => set({ primary_color: value })} />
      <ColorField label={t('settings.theme.background')} value={form.theme.background_color} onChange={(value) => set({ background_color: value })} />
      <ColorField label={t('settings.theme.text')} value={form.theme.text_color} onChange={(value) => set({ text_color: value })}>
        <ContrastWarning theme={form.theme} />
      </ColorField>
      <div>
        <label htmlFor={radiusId} className="mb-1 block text-sm font-medium text-text">{t('settings.theme.radius')}</label>
        <input id={radiusId} type="text" value={form.theme.border_radius} placeholder="8px" className="input"
          onChange={(event) => set({ border_radius: event.target.value })} />
      </div>
    </div>
  )
}
