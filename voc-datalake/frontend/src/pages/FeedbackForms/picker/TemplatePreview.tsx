/**
 * @fileoverview The picker's preview panel (UX §2.2, audit §1.4 A): the real widget in preview mode, in the "Create
 * in" language, as a phone (390 px logical, scaled to the card; preview/PreviewFrame), with Restart and "Open in
 * window ▾" (the preview window at a bigger size, following the template picked); under it the numbered
 * questions and their logic as sentences, so a person sees the flow before creating; and the one primary action,
 * "Use this template". While an AI draft is being made it shows the busy mark; with nothing picked, how to fill it.
 *
 * @module pages/FeedbackForms/picker/TemplatePreview
 */
import { createElement, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Flag, GitBranch, RotateCcw } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import { ThemeMarkThinking } from '../../../components/ThemeMark/ThemeMark'
import PreviewFrame from '../preview/PreviewFrame'
import type { PreviewCommand } from '../preview/PreviewFrame'
import WindowMenu from '../preview/WindowMenu'
import type { WindowPreset } from '../preview/previewChannel'
import { usePreviewWindowSync } from '../preview/usePreviewWindowSync'
import { questionIcon } from '../ui/typeIcons'
import type { FormV2 } from '../model/formsV2'
import { headlineShown } from '../model/recall'
import { logicSentences } from '../logic/ruleSentence'
import type { TemplateFlow } from '../templates/templateKit'

function QuestionOutline({ form }: Readonly<{ form: FormV2 }>) {
  const { t } = useTranslation('feedbackForms')
  const rules = form.questions.reduce((sum, question) => sum + logicSentences(t, form, question).length, 0)
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t('picker.preview.questions')}</h3>
      <ol className="space-y-2 text-[13px]" aria-label={t('picker.preview.questions')}>
        {form.questions.map((question, index) => {
          return (
            <li key={question.id} className="space-y-0.5">
              <span className="flex items-start gap-1.5 text-text">
                <span className="tabular-nums text-muted">{index + 1}</span>
                {createElement(questionIcon(question), { size: 14, className: 'mt-0.5 shrink-0 text-muted', 'aria-hidden': true })}
                <span className="min-w-0">{headlineShown(question.headline, form.language)}</span>
              </span>
              {logicSentences(t, form, question).map((sentence) => (
                <span key={sentence} className="ml-5 flex items-start gap-1 text-[12px] text-muted">
                  <GitBranch size={12} className="mt-0.5 shrink-0" aria-hidden="true" />{sentence}
                </span>
              ))}
            </li>
          )
        })}
      </ol>
      <p className="flex items-center gap-1.5 text-[12px] text-muted"><GitBranch size={12} aria-hidden="true" />{t('picker.preview.rules', { count: rules })}</p>
      <p className="flex items-center gap-1.5 text-[12px] text-muted"><Flag size={12} aria-hidden="true" />{t('picker.preview.endings', { count: form.endings.length })}</p>
    </div>
  )
}

export default function TemplatePreview({ flow, form, drafting, onUse }: Readonly<{
  flow: TemplateFlow | null
  /** The form the template makes in the "Create in" language (null: still loading that language). */
  form: FormV2 | null
  drafting: boolean
  onUse: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const [command, setCommand] = useState<PreviewCommand | null>(null)
  const [blocked, setBlocked] = useState(false)
  // (the picker's own preview window: it follows the template picked, in the "Create in" language)
  const previewWindow = usePreviewWindowSync(form, 'picker')
  const formLanguage = form?.language ?? null
  useEffect(() => {
    if (formLanguage !== null) previewWindow.setView({ language: formLanguage, target: null, scheme: null })
  }, [previewWindow, formLanguage])
  const open = useCallback((preset: WindowPreset) => setBlocked(!previewWindow.open(preset)), [previewWindow])
  const restart = () => {
    setCommand((current) => ({ kind: 'restart', nonce: (current?.nonce ?? 0) + 1 }))
    previewWindow.send({ kind: 'restart' })
  }
  if (drafting) {
    return (
      <div role="status" className="card flex flex-col items-center gap-3 py-12 text-sm text-muted">
        <ThemeMarkThinking className="h-10 w-10 text-accent-text" />{t('describe.drafting')}
      </div>
    )
  }
  if (flow === null) return <p className="card py-12 text-center text-sm text-muted">{t('picker.empty')}</p>
  const language = form === null ? null : languageNames[form.language]
  return (
    <section aria-labelledby={`preview-${flow.id}`} className="card space-y-4 p-4">
      <div>
        <h2 id={`preview-${flow.id}`} className="text-sm font-semibold tracking-tight text-text-strong">{t(`templates.${flow.id}.name`)}</h2>
        <p className="text-[13px] text-muted">{t(`templates.${flow.id}.purpose`)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn btn-ghost btn-sm" onClick={restart}>
          <RotateCcw size={14} aria-hidden="true" />{t('picker.preview.restart')}
        </button>
        <WindowMenu onOpen={open} />
      </div>
      {blocked && <p role="alert" className="text-[12px] text-warn">{t('preview.blocked')}</p>}
      {form === null
        ? <p role="status" className="text-[13px] text-muted">{t('picker.preview.loading')}</p>
        : (
          // (one column, the outline under the phone: the card is never wide enough for both side by side, and a 390 px
          // screen never scrolls sideways)
          <div className="grid grid-cols-1 gap-4">
            <div className="min-w-0">
              <PreviewFrame form={form} language={form.language} command={command} seed={previewWindow.seed}
                title={t('picker.preview.frameTitle', { language })} />
            </div>
            <div className="min-w-0"><QuestionOutline form={form} /></div>
          </div>
        )}
      <button type="button" className="btn btn-primary w-full" onClick={onUse} aria-disabled={form === null ? true : undefined}>
        {t('picker.use')}
      </button>
    </section>
  )
}
