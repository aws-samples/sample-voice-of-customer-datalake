/**
 * @fileoverview The builder's header (UX §3.1): the internal name edited inline, the state chip (Off / Live / Not
 * saved yet, and Test link on), the problems chip, the save status (`role="status"`), Save / Publish / Update live
 * form and the ⋯ menu. On narrow screens the save buttons also sit in a StickyActionBar.
 *
 * @module pages/FeedbackForms/builder/BuilderHeader
 */
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'react-router-dom'
import { ChevronLeft, FlaskConical, Pencil, PowerOff, Radio } from 'lucide-react'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { saveIgnoringFailure } from '../../../components/UnsavedChangesGuard/useSnapshotGuard'
import { useDraft } from './formDraftContext'
import type { FormDraft } from './formDraftContext'
import { FORMS_LIST_PATH } from './builderPaths'
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
      <Tooltip kind="label" content={t('builder.name.rename')}>
        <button type="button" className="icon-btn" aria-label={t('builder.name.rename')} onClick={() => setEditing(form.name)}>
          <Pencil size={16} aria-hidden="true" />
        </button>
      </Tooltip>
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

/** The save status, in words (never only a tooltip): saved, saving, failed with Try again, or what blocks a save. */
function SaveStatus() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { status } = draft
  if (status.kind === 'failed') {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
        {status.reason === 'save failed' ? t('builder.save.failedGeneric') : t('builder.save.failed', { reason: status.reason })}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => saveIgnoringFailure(draft.save)}>{t('builder.save.retry')}</button>
      </p>
    )
  }
  const text = (() => {
    if (status.kind === 'saving') return t('builder.save.saving')
    if (status.kind === 'saved') return savedText(t, status.message)
    if (draft.errors.length > 0) return t('builder.save.fixToSave', { count: draft.errors.length })
    return draft.dirty ? t('builder.save.unsaved') : ''
  })()
  return <p role="status" className="text-[13px] text-muted">{text}</p>
}

export default function BuilderHeader() {
  const { t } = useTranslation('feedbackForms')
  return (
    <header className="space-y-2">
      <Link to={FORMS_LIST_PATH} className="link inline-flex items-center gap-1 text-[13px]">
        <ChevronLeft size={14} aria-hidden="true" />{t('builder.back')}
      </Link>
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
      <StickyActionBar className="justify-end sm:hidden">
        <SaveButtons />
      </StickyActionBar>
    </header>
  )
}
