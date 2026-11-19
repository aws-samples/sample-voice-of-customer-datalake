/**
 * @fileoverview The theme editor's presets (audit §2.2): VoC light, VoC dark, High contrast and, once saved, "Your
 * brand" as toggle buttons (`aria-pressed` on the one the theme is exactly), each with its colours as dots; and
 * "Save as brand…", which asks first and saves the form's style as the form brand. Saving is for the `admins`
 * group (as every brand save): for anyone else the button stays focusable (`aria-disabled`) and says why in words,
 * as it does while the style's text is unreadable (a brand every new form starts on must be publishable).
 *
 * @module pages/FeedbackForms/theme/PresetPicker
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { BookmarkPlus, Check } from 'lucide-react'
import clsx from 'clsx'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { ignoreRejection } from '../../../lib/rejections'
import type { FormTheme } from '../model/formsV2'
import { offeredPresets, presetName, presetTheme } from './presets'
import type { PresetId } from './presets'
import { unreadablePalettes } from './contrast'
import type { FormBrand } from './useFormBrand'

/** A preset's colours as dots, in the palette it shows first (customer data, drawn as respondents see it). */
function PresetDots({ theme }: Readonly<{ theme: FormTheme }>) {
  const palette = theme.mode === 'dark' ? theme.dark : theme
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center rounded-full border border-control-border p-0.5"
      style={{ backgroundColor: palette.background_color }}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.primary_color }} />
      <span className="-ms-0.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.text_color }} />
    </span>
  )
}

/** Why "Save as brand…" is off (null: it is not): an admin's only, and only a style respondents can read. */
function saveReason(t: TFunction<'feedbackForms'>, canSave: boolean, unreadable: boolean): string | null {
  if (!canSave) return t('theme.presets.notAdmin')
  return unreadable ? t('theme.presets.unreadable') : null
}

export default function PresetPicker({ theme, pressed, brand, onPick }: Readonly<{
  theme: FormTheme
  /** The preset the theme is exactly (null: a custom style). */
  pressed: PresetId | null
  brand: FormBrand
  onPick: (id: PresetId) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const reasonId = useId()
  const [asking, setAsking] = useState(false)
  const [savedTheme, setSavedTheme] = useState<FormTheme | null>(null)
  const unreadable = unreadablePalettes(theme).length > 0
  const reason = saveReason(t, brand.canSave, unreadable)
  const save = async () => {
    setAsking(false)
    await brand.save(theme)
    setSavedTheme(theme)
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t('theme.presets.label')} className="tabs-track inline-flex flex-wrap">
          {offeredPresets(brand.brand).map((id) => {
            const preset = presetTheme(id, brand.brand)
            if (preset === null) return null
            return (
              <button key={id} type="button" aria-pressed={pressed === id} onClick={() => onPick(id)}
                className={clsx('tab', pressed === id && 'tab-active')}>
                <PresetDots theme={preset} />{presetName(t, id)}
              </button>
            )
          })}
        </div>
        {/* Off says why in words beside it (never a tooltip alone), and stays focusable. */}
        <button type="button" className="btn btn-ghost btn-sm" aria-disabled={reason === null ? undefined : true}
          aria-describedby={reason === null ? undefined : reasonId}
          onClick={() => { if (reason === null) setAsking(true) }}>
          <BookmarkPlus size={14} aria-hidden="true" />{t('theme.presets.saveAsBrand')}
        </button>
      </div>
      {reason !== null && <p id={reasonId} className="text-[12px] text-muted">{reason}</p>}
      {/* (after a save the server took, until the style changes again: never on a timer) */}
      {savedTheme !== null && brand.saved && savedTheme === theme && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-ok"><Check size={14} aria-hidden="true" />{t('theme.presets.saved')}</p>
      )}
      {brand.failed && <p role="alert" className="text-[12px] text-danger">{t('theme.presets.saveFailed')}</p>}
      <ConfirmModal isOpen={asking} variant="info" title={t('theme.presets.confirmTitle')}
        message={brand.brand === null ? t('theme.presets.confirmMessage') : t('theme.presets.confirmReplace')}
        confirmLabel={t('theme.presets.confirm')} isLoading={brand.saving}
        // (a refused save is shown by its alert above, from the mutation's own state)
        onConfirm={() => { save().catch(ignoreRejection) }} onCancel={() => setAsking(false)} />
    </div>
  )
}
