/**
 * @fileoverview The project's Decisions tab: every decision record, newest first, and the
 * editor. A deep link (`decisionDeepLink`, e.g. from a brief card) opens the editor
 * prefilled; nothing is saved until the user presses Save.
 * @module pages/ProjectDetail/decisions/DecisionsTab
 */
import { Plus, Scale } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { decisionsOf } from '../../../api/decisionSchema'
import type { Decision } from '../../../api/decisionSchema'
import type { ProjectDocument } from '../../../api/types'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import DecisionCard from './DecisionCard'
import DecisionForm from './DecisionForm'
import { EMPTY_DRAFT, PREFILL_PARAMS, draftFromDecision, draftFromParams } from './decisionDraft'
import type { DecisionDraft } from './decisionDraft'
import { useDecisionMutations } from './useDecisionMutations'
import { useSeededPrfaqs } from './useSeededPrfaqs'

interface DecisionsTabProps {
  readonly projectId: string
  readonly documents: readonly ProjectDocument[]
  readonly canEdit: boolean
  readonly onJobStarted?: () => void
}

/** What the editor is open for: a new decision (with its draft) or an existing one. */
type Editor = { kind: 'new'; draft: DecisionDraft } | { kind: 'edit'; decision: Decision } | null

/** Reads a deep link's prefill once, then drops its parameters from the URL. */
function usePrefillFromUrl(canEdit: boolean, open: (draft: DecisionDraft) => void) {
  const [searchParams, setSearchParams] = useSearchParams()
  const prefill = useMemo(() => draftFromParams(searchParams), [searchParams])
  useEffect(() => {
    if (prefill === null) return
    if (canEdit) open(prefill)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      PREFILL_PARAMS.forEach((name) => next.delete(name))
      return next
    }, { replace: true })
  }, [prefill, canEdit, open, setSearchParams])
}

/** The form's starting draft and, for an edit, what the save targets. */
function editorTarget(editor: Editor): { initial: DecisionDraft; editing?: { documentId: string; revision: number } } {
  if (editor === null) return { initial: EMPTY_DRAFT }
  if (editor.kind === 'new') return { initial: editor.draft }
  return {
    initial: draftFromDecision(editor.decision),
    editing: { documentId: editor.decision.documentId, revision: editor.decision.revision },
  }
}

function TabHeader({ showNew, onNew }: Readonly<{ showNew: boolean; onNew: () => void }>) {
  const { t } = useTranslation('decisions')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 id="decisions-heading" className="text-lg font-semibold tracking-tight text-text-strong inline-flex items-center gap-2">
          <Scale size={18} aria-hidden />{t('title')}
        </h2>
        <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
      </div>
      {showNew && (
        <button type="button" className="btn btn-primary" onClick={onNew}>
          <Plus size={16} aria-hidden />{t('new')}
        </button>
      )}
    </div>
  )
}

/** "Draft a PR/FAQ" runs a minutes-long AI generation, so it is asked first — never one click. */
function PursueConfirm({ decision, onConfirm, onCancel }: Readonly<{
  decision: Decision | null; onConfirm: (decision: Decision) => void; onCancel: () => void
}>) {
  const { t } = useTranslation('decisions')
  return (
    <ConfirmModal
      isOpen={decision !== null}
      variant="info"
      title={t('actions.pursueConfirmTitle')}
      message={t('actions.pursueConfirmMessage', { title: decision?.title ?? '' })}
      confirmLabel={t('actions.pursueConfirm')}
      cancelLabel={t('actions.cancel')}
      onConfirm={() => { if (decision !== null) onConfirm(decision) }}
      onCancel={onCancel}
    />
  )
}

/** Deleting a decision removes the record for everyone on the project, so it is asked first. */
function DeleteConfirm({ decision, isDeleting, failed, onConfirm, onCancel }: Readonly<{
  decision: Decision | null; isDeleting: boolean; failed: boolean
  onConfirm: (decision: Decision) => void; onCancel: () => void
}>) {
  const { t } = useTranslation('decisions')
  const message = t('actions.deleteConfirmMessage', { title: decision?.title ?? '' })
  return (
    <ConfirmModal
      isOpen={decision !== null}
      variant="danger"
      title={t('actions.deleteConfirmTitle')}
      message={failed ? `${message} ${t('errors.delete')}` : message}
      confirmLabel={t('actions.deleteConfirm')}
      cancelLabel={t('actions.cancel')}
      isLoading={isDeleting}
      onConfirm={() => { if (decision !== null) onConfirm(decision) }}
      onCancel={onCancel}
    />
  )
}

export default function DecisionsTab({ projectId, documents, canEdit, onJobStarted }: DecisionsTabProps) {
  const { t, i18n } = useTranslation('decisions')
  const [editor, setEditor] = useState<Editor>(null)
  const [confirmingPursue, setConfirmingPursue] = useState<Decision | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<Decision | null>(null)
  const decisions = useMemo(() => decisionsOf(documents), [documents])
  const citable = useMemo(() => documents.filter((d) => d.document_type !== 'decision'), [documents])
  const { save, remove, pursue } = useDecisionMutations(projectId, onJobStarted)
  const seededJobs = useSeededPrfaqs(projectId, decisions)
  const resetSave = save.reset
  const openNew = useCallback((draft: DecisionDraft) => {
    resetSave()
    setEditor({ kind: 'new', draft })
  }, [resetSave])
  usePrefillFromUrl(canEdit, openNew)

  const close = () => setEditor(null)
  const { initial, editing } = editorTarget(editor)

  return (
    <section className="space-y-4" aria-labelledby="decisions-heading">
      <TabHeader showNew={canEdit && editor === null} onNew={() => openNew(EMPTY_DRAFT)} />
      {editor !== null && (
        <DecisionForm
          key={editing?.documentId ?? 'new'}
          initial={initial}
          documents={citable.filter((d) => d.document_id !== editing?.documentId)}
          isSaving={save.isPending}
          error={save.error}
          onCancel={close}
          onSave={(input) => save.mutate({ input, editing }, { onSuccess: close })}
        />
      )}
      {pursue.isError && <p className="text-sm text-danger" role="alert">{t('errors.pursue')}</p>}
      {decisions.length === 0 && editor === null && <p className="text-sm text-muted">{t('empty')}</p>}
      <div className="space-y-3">
        {decisions.map((decision) => (
          <DecisionCard
            key={decision.documentId}
            projectId={projectId}
            decision={decision}
            documents={documents}
            canEdit={canEdit}
            isPursuing={pursue.isPending && pursue.variables.documentId === decision.documentId}
            prfaqJob={decision.seededPrfaqJobId === null ? undefined : seededJobs.get(decision.seededPrfaqJobId)}
            onEdit={() => {
              resetSave()
              setEditor({ kind: 'edit', decision })
            }}
            onPursue={() => setConfirmingPursue(decision)}
            onDelete={() => {
              remove.reset()
              setConfirmingDelete(decision)
            }}
          />
        ))}
      </div>
      <DeleteConfirm
        decision={confirmingDelete}
        isDeleting={remove.isPending}
        failed={remove.isError}
        onCancel={() => setConfirmingDelete(null)}
        onConfirm={(decision) => {
          if (editing?.documentId === decision.documentId) close()
          remove.mutate(decision.documentId, { onSuccess: () => setConfirmingDelete(null) })
        }}
      />
      <PursueConfirm
        decision={confirmingPursue}
        onCancel={() => setConfirmingPursue(null)}
        onConfirm={(decision) => {
          setConfirmingPursue(null)
          pursue.mutate({ documentId: decision.documentId, language: i18n.language })
        }}
      />
    </section>
  )
}
