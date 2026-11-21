/**
 * @fileoverview The builder's header (UX §3.1): the internal name edited inline, the state chip (Off / Live / Not
 * saved yet, and Test link on), the problems chip, the save status (`role="status"`), Save / Publish / Update live
 * form and the ⋯ menu. On a phone the save buttons sit in `BuilderActionBar` instead, which the page renders after
 * the tab's content.
 *
 * @module pages/FeedbackForms/builder/BuilderHeader
 */
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronLeft, FlaskConical, Pencil, PowerOff, Radio } from 'lucide-react'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { saveIgnoringFailure } from '../../../components/UnsavedChangesGuard/useSnapshotGuard'
import { useDraft } from './formDraftContext'
import type { FormDraft } from './formDraftContext'
import { FORMS_LIST_PATH } from './builderPaths'
import { useBuilderUi } from './builderUi'
import { goToProblem } from './problemText'
import type { FormProblem } from '../model/validateForm'
import { QUESTION_ID_REUSED, THEME_UNREADABLE } from './useFormDraft'
import ProblemsPopover from './ProblemsPopover'
import SaveButtons from './SaveButtons'
import FormMenu from './FormMenu'

function FormName() {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const [editing, setEditing] = useState<string | null>(null)
  const name = form.name.trim() === '' ? t('builder.name.untitled') : form.name
  const commit = () => {
    if (editing !== null) update((current) => ({ ...current, name: editing.trim() }))
    setEditing(null)
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') setEditing(null)
  }
  if (editing !== null) {
    return (
      // (focus follows the person's click on Rename: the field replaces the button they pressed)
      <input className="input max-w-md text-lg font-semibold" aria-label={t('builder.name.label')} value={editing} autoFocus
        onChange={(event) => setEditing(event.target.value)} onKeyDown={onKey} onBlur={commit} />
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <h1 className="truncate text-2xl font-bold tracking-tight text-text-strong">{name}</h1>
      <button title={t('builder.name.rename')} type="button" className="icon-btn" aria-label={t('builder.name.rename')} onClick={() => setEditing(form.name)}>
        <Pencil size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

function StateChips() {
  const { t } = useTranslation('feedbackForms')
  const { form, isNew } = useDraft()
  const testOn = form.settings.test.link_enabled
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {isNew && <span className="badge badge-muted">{t('builder.state.notSaved')}</span>}
      {!isNew && form.enabled && <span className="badge badge-ok inline-flex items-center gap-1"><Radio size={12} aria-hidden="true" />{t('builder.state.live')}</span>}
      {!isNew && !form.enabled && <span className="badge badge-muted inline-flex items-center gap-1"><PowerOff size={12} aria-hidden="true" />{t('builder.state.off')}</span>}
      {testOn && <span className="badge badge-info inline-flex items-center gap-1"><FlaskConical size={12} aria-hidden="true" />{t('builder.state.testOn')}</span>}
    </span>
  )
}

function savedText(t: TFunction<'feedbackForms'>, message: Extract<FormDraft['status'], { kind: 'saved' }>['message']): string {
  switch (message) {
    case 'saved': return t('builder.save.saved')
    case 'firstSave': return t('builder.firstSave')
    case 'published': return t('builder.published')
    case 'aiSaved': return t('builder.aiSaved')
    case 'turnedOff': return t('builder.turnedOff')
  }
}

/**
 * A failed save in words: the server's reason, its refusal of an unreadable theme or of a removed question's id taken
 * again (with the id), or the generic message.
 */
function failedText(t: TFunction<'feedbackForms'>, failed: Extract<FormDraft['status'], { kind: 'failed' }>): string {
  const { reason } = failed
  if (reason === 'save failed') return t('builder.save.failedGeneric')
  if (reason === THEME_UNREADABLE) return t('builder.save.themeRefused')
  if (reason === QUESTION_ID_REUSED) return t('builder.save.questionIdReused', { id: failed.questionId ?? '' })
  return t('builder.save.failed', { reason })
}

/** The save status, in words (never only a tooltip): saved, saving, failed with Try again, or what blocks a save. */
function SaveStatus() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { status } = draft
  if (status.kind === 'failed') {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
        {failedText(t, status)}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => saveIgnoringFailure(draft.save)}>{t('builder.save.retry')}</button>
      </p>
    )
  }
  const text = (() => {
    if (status.kind === 'saving') return t('builder.save.saving')
    if (status.kind === 'saved') return savedText(t, status.message)
    if (draft.errors.length > 0) return t('builder.save.fixToSave', { count: draft.errors.length })
    // An unreadable theme blocks only Publish: Save still works, and the line says both.
    if (draft.publishErrors.length > 0) return t('builder.save.fixToPublishSaveWorks', { count: draft.publishErrors.length })
    return draft.dirty ? t('builder.save.unsaved') : ''
  })()
  const hardToRead = draft.problems.find((found) => found.code === 'themeUnreadableLive')
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
      {text !== '' && <span>{text}</span>}
      {hardToRead !== undefined && <HardToRead at={hardToRead.at} />}
    </p>
  )
}

/** A live form kept on its stored, unreadable theme (it saves, with the server's warning): a warning in words, with the
 * way to its colours. */
function HardToRead({ at }: Readonly<{ at: FormProblem['at'] }>) {
  const { t } = useTranslation('feedbackForms')
  const ui = useBuilderUi()
  return (
    <span className="inline-flex items-center gap-1 text-text">
      <AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-warn" />
      {t('builder.save.themeHardToRead')}{' '}
      <button type="button" className="link" onClick={() => goToProblem(ui, at)}>{t('builder.save.themeFix')}</button>
    </span>
  )
}

/** "‹ Feedback Forms": the way back to the list, above the header and above a form that could not load (F26). */
export function BackToForms() {
  const { t } = useTranslation('feedbackForms')
  return (
    <Link to={FORMS_LIST_PATH} className="link inline-flex items-center gap-1 text-[13px]">
      <ChevronLeft size={14} aria-hidden="true" />{t('builder.back')}
    </Link>
  )
}

/**
 * Whether the save buttons show anything: SaveButtons' table (Publish while the form is Off or new, Save beside it
 * with edits, Update live form for a Live form with edits) leaves nothing only for a Live form without edits.
 */
function hasSaveButton(draft: FormDraft): boolean {
  const live = draft.form.enabled && !draft.isNew
  return !live || draft.dirty
}

/**
 * The save buttons on a phone (below `sm`, where the header keeps only the ⋯): a StickyActionBar at the END of the
 * builder, after the tab's content, so `sticky bottom-0` pins it to the bottom of the page while the tab scrolls (in
 * the header it never stuck), and rendered only while a button shows, so no empty pill sits under the ⋯ (F15).
 */
export function BuilderActionBar() {
  const draft = useDraft()
  if (!hasSaveButton(draft)) return null
  return (
    <StickyActionBar className="justify-end sm:hidden">
      <SaveButtons />
    </StickyActionBar>
  )
}

export default function BuilderHeader() {
  return (
    <header className="space-y-2">
      <BackToForms />
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <FormName />
          <div className="flex flex-wrap items-center gap-2">
            <StateChips />
            <ProblemsPopover />
            <SaveStatus />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <div className="hidden sm:flex"><SaveButtons withShortcut /></div>
          <FormMenu />
        </div>
      </div>
    </header>
  )
}
