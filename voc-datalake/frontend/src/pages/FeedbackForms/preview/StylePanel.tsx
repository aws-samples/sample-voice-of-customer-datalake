/**
 * @fileoverview The Questions tab's Style panel (audit §2.1): the form's look, beside the preview that shows it, so a
 * colour, a corner or a font is judged on the form itself as it changes. The preview toolbar's Style button opens it:
 *
 * - from xl, `StyleColumn` takes the editor's column while the preview stays where it is; "Back to question"
 *   returns (and the focus with it, to the Style button);
 * - below xl, `StyleSheet` is a wide side sheet with the phone at its top.
 *
 * The palette being edited (light or dark) is the one the previews show meanwhile, whatever the device prefers
 * (`onEditingSchemeChange`, the preview's `scheme`). One draft and one Save as everywhere in the builder: the theme
 * is part of the form.
 *
 * @module pages/FeedbackForms/preview/StylePanel
 */
import { useId, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Palette } from 'lucide-react'
import SideSheet from '../../../components/SideSheet/SideSheet'
import { languageNames } from '../../../i18n/languages'
import type { FormV2 } from '../model/formsV2'
import ThemeEditor from '../theme/ThemeEditor'
import PreviewFrame from './PreviewFrame'
import { usePreviewWindow } from './previewWindowContext'
import type { PreviewScheme } from './widgetScript'

/** The sheet's phone: 480 logical px tall, so the controls start in view under it. */
const SHEET_PHONE_HEIGHT = 480

interface StyleBodyProps {
  /** The palette the editor is editing (null: neither in particular), for the preview to show. */
  readonly onEditingSchemeChange: (scheme: PreviewScheme | null) => void
}

/** The panel's controls: the theme editor of the form's draft (the same as Settings › Appearance's). */
function StyleBody({ onEditingSchemeChange }: StyleBodyProps) {
  return <ThemeEditor onEditingSchemeChange={onEditingSchemeChange} />
}

/** From xl: the Style panel in the editor's column. */
export function StyleColumn({ onBack, onEditingSchemeChange }: Readonly<StyleBodyProps & { onBack: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const titleId = useId()
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  // (in on open; back to what opened it, the Style button, when the panel goes with the focus inside it)
  useLayoutEffect(() => {
    const opener = document.activeElement
    const panel = section.current
    heading.current?.focus()
    return () => {
      if (panel?.contains(document.activeElement) === true && opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return (
    <section ref={section} aria-labelledby={titleId} className="space-y-3">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
        <ChevronLeft size={14} aria-hidden="true" />{t('preview.stylePanel.back')}
      </button>
      <h2 ref={heading} id={titleId} tabIndex={-1} className="flex items-center gap-2 text-base font-semibold tracking-tight text-text-strong focus:outline-none">
        <Palette size={16} className="text-accent" aria-hidden="true" />{t('preview.stylePanel.title')}
      </h2>
      <StyleBody onEditingSchemeChange={onEditingSchemeChange} />
    </section>
  )
}

/** Below xl: the Style panel as a wide side sheet, the phone at its top. */
export function StyleSheet({ isOpen, onClose, form, scheme, onEditingSchemeChange }: Readonly<StyleBodyProps & {
  isOpen: boolean
  onClose: () => void
  form: FormV2
  /** The palette the sheet's phone shows (the one being edited). */
  scheme: PreviewScheme | null
}>) {
  const { t } = useTranslation('feedbackForms')
  const seed = usePreviewWindow()?.seed
  const title = t('preview.frameTitle', { size: t('preview.device.phone'), language: languageNames[form.language] })
  return (
    <SideSheet isOpen={isOpen} onClose={onClose} title={t('preview.stylePanel.title')} icon={Palette} size="wide">
      <PreviewFrame form={form} language={form.language} title={title} scheme={scheme} seed={seed} fit={SHEET_PHONE_HEIGHT} />
      <StyleBody onEditingSchemeChange={onEditingSchemeChange} />
    </SideSheet>
  )
}
