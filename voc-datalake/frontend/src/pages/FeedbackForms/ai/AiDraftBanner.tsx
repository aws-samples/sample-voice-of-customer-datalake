/**
 * @fileoverview The AI banner above the builder's tabs (UX §12.3), on every tab while the draft carries the AI's
 * provenance (until its first Save):
 *
 * - an AI draft: "AI draft: review before publishing. Nothing is saved yet.", its notes folded, and Discard draft
 *   (asks, then back to the picker with the description kept);
 * - after Improve with AI: "Changed with AI: review before saving." and Undo AI changes (back to the form before);
 * - the model's warnings, always shown, each with Go to when it names a question or an ending;
 * - the addresses the AI suggested, each to confirm or remove.
 *
 * @module pages/FeedbackForms/ai/AiDraftBanner
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import type { DraftNote } from '../../../api/feedbackFormsV2Api'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import { pickerPath } from '../builder/builderPaths'
import AiAddressList from './AiAddressList'

function Warnings({ warnings }: Readonly<{ warnings: readonly DraftNote[] }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const ui = useBuilderUi()
  const goTo = (target: string | undefined) => {
    if (draft.form.questions.some((question) => question.id === target)) return () => ui.go('questions', [target ?? ''])
    if (draft.form.endings.some((ending) => ending.id === target)) return () => ui.go('questions', ['end', target ?? ''])
    return null
  }
  if (warnings.length === 0) return null
  return (
    <ul className="space-y-1">
      {warnings.map((warning) => {
        const go = goTo(warning.target)
        return (
          <li key={warning.message} className="flex items-start gap-2 text-[13px] text-text">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            {/* (Go to right after its sentence: at the row's end it sat about 500 px from what it is about) */}
            <span className="min-w-0">
              {warning.message}
              {go !== null && <>{' '}<button type="button" className="link" onClick={go}>{t('ai.banner.goTo')}</button></>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Notes({ notes }: Readonly<{ notes: readonly DraftNote[] }>) {
  const { t } = useTranslation('feedbackForms')
  const [open, setOpen] = useState(false)
  const id = useId()
  if (notes.length === 0) return null
  return (
    <div>
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {t('ai.banner.notes', { count: notes.length })}
      </button>
      <ul id={id} hidden={!open} className="mt-1 list-disc space-y-0.5 pl-6 text-[13px] text-text">
        {notes.map((note) => <li key={note.message}>{note.message}</li>)}
      </ul>
    </div>
  )
}

export default function AiDraftBanner() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const ui = useBuilderUi()
  const [discarding, setDiscarding] = useState(false)
  const { ai } = draft
  if (ai === null) return null
  const before = ai.before
  const undo = () => {
    if (before !== null) draft.update(() => before)
    draft.setAi(() => null)
  }
  return (
    <section aria-label={t('ai.banner.label')} className="space-y-2 rounded-lg border border-aim/30 bg-aim-subtle p-3 text-text">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={16} className="shrink-0 text-aim" aria-hidden="true" />
        <p className="mr-auto text-sm font-medium">{ai.kind === 'draft' ? t('ai.banner.draft') : t('ai.banner.improve')}</p>
        {ai.kind === 'draft'
          ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDiscarding(true)}>
              <Trash2 size={14} aria-hidden="true" />{t('ai.banner.discard')}
            </button>
          )
          : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={undo}>
              <RotateCcw size={14} aria-hidden="true" />{t('ai.banner.undo')}
            </button>
          )}
      </div>
      <Notes notes={ai.notes} />
      <Warnings warnings={ai.warnings} />
      <AiAddressList />
      <ConfirmModal isOpen={discarding} title={t('ai.banner.discardConfirm.title')} message={t('ai.banner.discardConfirm.message')}
        confirmLabel={t('ai.banner.discardConfirm.confirm')} variant="danger"
        onConfirm={() => { setDiscarding(false); ui.leave(pickerPath(), { describe: ai.description }) }} onCancel={() => setDiscarding(false)} />
    </section>
  )
}
