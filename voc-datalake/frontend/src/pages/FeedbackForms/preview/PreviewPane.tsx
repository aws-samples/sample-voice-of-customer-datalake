/**
 * @fileoverview The live preview's pane (UX §3.5): the real widget (PreviewFrame, in the page, never submitting) with
 * Phone | Desktop, the language ("English (4 missing, shown in Polski)"), Restart and Start here, and "Preview ·
 * nothing is sent". It follows the editor's selection: selecting a question moves the preview to it.
 *
 * @module pages/FeedbackForms/preview/PreviewPane
 */
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ExternalLink, Locate, Monitor, RotateCcw, Smartphone } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { missingTexts } from '../model/translatable'
import { formPreviewPath } from '../builder/builderPaths'
import Segmented from '../ui/Segmented'
import PreviewFrame from './PreviewFrame'
import type { PreviewCommand } from './PreviewFrame'

type Device = 'phone' | 'desktop'

function LanguageSelect({ form, value, onChange }: Readonly<{ form: FormV2; value: FormLanguage; onChange: (language: FormLanguage) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  if (form.languages.length < 2) return null
  return (
    <span className="flex items-center gap-1">
      <label htmlFor={id} className="sr-only">{t('preview.language')}</label>
      <select id={id} className="select select-sm w-auto" value={value}
        onChange={(event) => {
          const next = form.languages.find((lng) => lng === event.target.value)
          if (next !== undefined) onChange(next)
        }}>
        {form.languages.map((lng) => {
          const missing = missingTexts(form, lng).length
          return (
            <option key={lng} value={lng}>
              {missing === 0 ? languageNames[lng] : t('preview.languageMissing', { language: languageNames[lng], count: missing, primary: languageNames[form.language] })}
            </option>
          )
        })}
      </select>
    </span>
  )
}

export default function PreviewPane({ form, formId, selectedQuestionId }: Readonly<{
  form: FormV2
  /** The stored form (Full screen opens its preview page); null for a new form. */
  formId: string | null
  /** The question selected in the editor (the preview follows it; Start here goes to it). */
  selectedQuestionId: string | null
}>) {
  const { t } = useTranslation('feedbackForms')
  const [device, setDevice] = useState<Device>('phone')
  const [chosen, setChosen] = useState<FormLanguage>(form.language)
  // A Restart or Start here, pressed while `selection` was selected (a new selection supersedes it).
  const [manual, setManual] = useState<{ readonly command: PreviewCommand; readonly selection: string | null } | null>(null)
  const language = form.languages.includes(chosen) ? chosen : form.language
  // (a selection made in the editor moves the preview to that question: a new command per selection)
  const followed = useMemo<PreviewCommand | null>(
    () => (selectedQuestionId === null ? null : { kind: 'goTo', questionId: selectedQuestionId, nonce: 0 }), [selectedQuestionId])
  const command = manual !== null && manual.selection === selectedQuestionId ? manual.command : followed
  const send = (next: (n: number) => PreviewCommand) =>
    setManual((current) => ({ command: next((current?.command.nonce ?? 0) + 1), selection: selectedQuestionId }))
  const title = t('preview.frameTitle', { size: t(`preview.device.${device}`), language: languageNames[language] })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label={t('preview.deviceLabel')} value={device} onChange={setDevice}
          choices={[{ value: 'phone', label: t('preview.phone'), icon: Smartphone }, { value: 'desktop', label: t('preview.desktop'), icon: Monitor }]} />
        <LanguageSelect form={form} value={language} onChange={setChosen} />
      </div>
      <PreviewFrame form={form} language={language} device={device} title={title} command={command} />
      <p className="text-[12px] text-muted">{t('preview.nothingSent')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => send((n) => ({ kind: 'restart', nonce: n }))}>
          <RotateCcw size={14} aria-hidden="true" />{t('preview.restart')}
        </button>
        {selectedQuestionId !== null && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => send((n) => ({ kind: 'goTo', questionId: selectedQuestionId, nonce: n }))}>
            <Locate size={14} aria-hidden="true" />{t('preview.startHere')}
          </button>
        )}
        {device === 'desktop' && formId !== null && (
          <Link to={formPreviewPath(formId)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            <ExternalLink size={14} aria-hidden="true" />{t('preview.fullScreen')}
          </Link>
        )}
      </div>
    </div>
  )
}
