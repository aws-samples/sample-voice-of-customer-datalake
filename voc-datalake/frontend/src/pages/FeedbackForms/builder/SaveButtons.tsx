/**
 * @fileoverview The builder's Save, Publish and Update live form (UX §3.1's table, R10: two buttons at most):
 *
 * | State | Secondary | Primary |
 * |---|---|---|
 * | Off, no edits | — | Publish |
 * | Off (or new), with edits | Save | Publish (saves, then turns the form Live) |
 * | Live, no edits | — | — |
 * | Live, with edits | — | Update live form |
 *
 * With errors both are `aria-disabled` with the reason in their `title` (the status line says it in words too). An
 * unreadable theme (text under 3:1 on its background) blocks only Publish and Update live form: Save stays, so nothing
 * is lost while the colours are fixed. ⌘/Ctrl+S saves, or updates the live form.
 *
 * They ask first when: a language the form offers is incomplete ("English respondents will see 5 texts in Polski",
 * Publish anyway or Translate: audit F17); an AI draft nobody has saved is published (UX §12.3); an update of a live
 * form removes something with answers (UX §3.6, the list of it).
 *
 * @module pages/FeedbackForms/builder/SaveButtons
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages, Loader2, Radio, Save } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { saveIgnoringFailure } from '../../../components/UnsavedChangesGuard/useSnapshotGuard'
import { languageNames } from '../../../i18n/languages'
import { isFormLanguage } from '../model/formsV2'
import { incompleteLanguages } from '../model/validateForm'
import { useDraft } from './formDraftContext'
import { useBuilderUi } from './builderUi'
import { removedParts } from './draftChanges'
import { noCleanup } from '../../../hooks/noCleanup'

type Next = 'publish' | 'update'
type Pending =
  | { readonly kind: 'languages'; readonly next: Next }
  | { readonly kind: 'aiPublish' }
  | { readonly kind: 'removal'; readonly list: string }
  | null

function useBuilderSaveKey(onSave: (() => void) | null): void {
  useEffect(() => {
    if (onSave === null) return noCleanup
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      onSave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave])
}

const nameOf = (language: string): string => (isFormLanguage(language) ? languageNames[language] : language)

/** What the buttons do: Save, Publish and Update live form, each with the questions it asks first. */
function useSaveActions() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const [pending, setPending] = useState<Pending>(null)
  const live = draft.form.enabled && !draft.isNew
  const ready = draft.errors.length === 0 && draft.status.kind !== 'saving'
  const missing = incompleteLanguages(draft.problems)
  const update = (askedLanguages = false) => {
    if (!askedLanguages && missing.length > 0) { setPending({ kind: 'languages', next: 'update' }); return }
    const list = draft.baseline !== null && draft.locked ? removedParts(t, draft.baseline, draft.form) : []
    if (list.length > 0) setPending({ kind: 'removal', list: list.join(', ') })
    else saveIgnoringFailure(draft.save)
  }
  const publish = (askedLanguages = false) => {
    if (!askedLanguages && missing.length > 0) { setPending({ kind: 'languages', next: 'publish' }); return }
    if (draft.ai?.kind === 'draft' && draft.isNew) setPending({ kind: 'aiPublish' })
    else saveIgnoringFailure(draft.publish)
  }
  const save = () => saveIgnoringFailure(draft.save)
  const confirm = () => {
    setPending(null)
    if (pending?.kind === 'languages') (pending.next === 'publish' ? publish : update)(true)
    else saveIgnoringFailure(pending?.kind === 'aiPublish' ? draft.publish : draft.save)
  }
  const saveReason = draft.errors.length > 0 ? t('builder.save.fixToSave', { count: draft.errors.length }) : undefined
  const publishReason = draft.publishErrors.length > 0 ? t('builder.save.fixToPublish', { count: draft.publishErrors.length }) : undefined
  return {
    showSave: !live && draft.dirty,
    showPrimary: !live || draft.dirty,
    primaryLabel: live ? t('builder.save.update') : t('builder.save.publish'),
    onPrimary: live ? () => update() : () => publish(),
    publish: () => publish(),
    busy: draft.status.kind === 'saving',
    saveReason,
    // Live: the save IS Update live form, so its errors are already every error.
    primaryReason: live ? saveReason : publishReason ?? saveReason,
    pending, missing, primary: draft.form.language,
    save, confirm,
    cancel: () => setPending(null),
    shortcut: () => { if (draft.dirty && ready) (live ? update : save)() },
  }
}

/** One of the two buttons: `aria-disabled` with the reason while errors block it (UX §3.1). */
function SaveButton({ primary, label, busy, reason, onClick }: Readonly<{
  primary: boolean; label: string; busy: boolean; reason: string | undefined; onClick: () => void
}>) {
  const off = reason !== undefined || busy
  const icon = busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />
  return (
    <button title={reason} type="button" className={primary ? 'btn btn-primary' : 'btn btn-secondary'} aria-disabled={off}
      onClick={() => { if (!off) onClick() }}>
      {primary ? <Radio size={16} aria-hidden="true" /> : icon}
      {label}
    </button>
  )
}

/** F17: the offered languages that are incomplete, each with the way to its translation view. */
function LanguagesConfirm({ actions }: Readonly<{ actions: ReturnType<typeof useSaveActions> }>) {
  const { t } = useTranslation('feedbackForms')
  const ui = useBuilderUi()
  const { pending, missing } = actions
  const next = pending?.kind === 'languages' ? pending.next : 'publish'
  const primary = nameOf(actions.primary)
  const message = missing.map((entry) => t('builder.confirmLanguages.line', { language: nameOf(entry.language), count: entry.count, primary })).join(' ')
  return (
    <ConfirmModal isOpen={pending?.kind === 'languages'} variant="warning"
      title={next === 'publish' ? t('builder.confirmLanguages.titlePublish') : t('builder.confirmLanguages.titleUpdate')}
      message={message}
      confirmLabel={next === 'publish' ? t('builder.confirmLanguages.publishAnyway') : t('builder.confirmLanguages.updateAnyway')}
      onConfirm={actions.confirm} onCancel={actions.cancel}>
      <div className="mt-3 flex flex-wrap gap-2">
        {missing.map((entry) => (
          <button key={entry.language} type="button" className="btn btn-secondary btn-sm"
            onClick={() => { actions.cancel(); ui.go('languages', [entry.language]) }}>
            <Languages size={14} aria-hidden="true" />{t('builder.confirmLanguages.translate', { language: nameOf(entry.language) })}
          </button>
        ))}
      </div>
    </ConfirmModal>
  )
}

/** The questions Save, Publish and Update live form ask first: incomplete languages, an AI draft, removals. */
function SaveDialogs({ actions }: Readonly<{ actions: ReturnType<typeof useSaveActions> }>) {
  const { t } = useTranslation('feedbackForms')
  const { pending } = actions
  return (
    <>
      <LanguagesConfirm actions={actions} />
      <ConfirmModal isOpen={pending?.kind === 'aiPublish'} title={t('builder.confirmAiPublish.title')}
        message={t('builder.confirmAiPublish.message')} confirmLabel={t('builder.confirmAiPublish.confirm')} variant="warning"
        onConfirm={actions.confirm} onCancel={actions.cancel} />
      <ConfirmModal isOpen={pending?.kind === 'removal'} title={t('builder.confirmRemoval.title')}
        message={t('builder.confirmRemoval.message', { list: pending?.kind === 'removal' ? pending.list : '' })}
        confirmLabel={t('builder.confirmRemoval.confirm')} variant="warning" onConfirm={actions.confirm} onCancel={actions.cancel} />
    </>
  )
}

/**
 * Publish from somewhere else than the header (the Share tab's Off banner), asking the same questions the header's
 * Publish asks: `children` gets the publish action.
 */
export function PublishFlow({ children }: Readonly<{ children: (publish: () => void) => ReactNode }>) {
  const actions = useSaveActions()
  return (
    <>
      {children(actions.publish)}
      <SaveDialogs actions={actions} />
    </>
  )
}

export default function SaveButtons({ withShortcut = false }: Readonly<{ withShortcut?: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const actions = useSaveActions()
  useBuilderSaveKey(withShortcut ? actions.shortcut : null)
  const { busy } = actions
  return (
    <div className="flex items-center gap-2">
      {actions.showSave && <SaveButton primary={false} label={t('builder.save.save')} busy={busy} reason={actions.saveReason} onClick={actions.save} />}
      {actions.showPrimary && <SaveButton primary label={actions.primaryLabel} busy={busy} reason={actions.primaryReason} onClick={actions.onPrimary} />}
      <SaveDialogs actions={actions} />
    </div>
  )
}
