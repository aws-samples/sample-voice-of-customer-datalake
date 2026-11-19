/**
 * @fileoverview A stale save (D7: the server answered 409, someone else saved first): a `role="alert"` banner
 * ("Ana saved this form at 14:02.") with **Compare** (their version beside this draft, in a dialog: what saving
 * mine would add, remove and change), **Reload theirs** (drop this draft's edits) and **Save mine** (save over
 * their version). The Documents conflict pattern, without merge.
 *
 * @module pages/FeedbackForms/builder/ConflictBanner
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, GitCompare } from 'lucide-react'
import FormDialog from '../ui/FormDialog'
import { saveIgnoringFailure } from '../../../components/UnsavedChangesGuard/useSnapshotGuard'
import { formatTime } from '../../../utils/dateUtils'
import { useAuthStore } from '../../../store/authStore'
import { useDraft } from './formDraftContext'
import { conflictDifferences } from './draftChanges'
import type { ConflictDifference } from './draftChanges'

function CompareSheet({ differences, onClose }: Readonly<{ differences: readonly ConflictDifference[] | null; onClose: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const groups = (['added', 'removed', 'changed'] as const).map((kind) => ({ kind, items: (differences ?? []).filter((d) => d.kind === kind) }))
  return (
    <FormDialog isOpen={differences !== null} onClose={onClose} title={t('builder.conflict.compareTitle')}
      description={t('builder.conflict.compareDescription')} icon={GitCompare}
      footer={<button type="button" className="btn btn-secondary" onClick={onClose}>{t('builder.conflict.close')}</button>}>
      {differences?.length === 0 && <p className="text-sm text-muted">{t('builder.conflict.noDifferences')}</p>}
      {groups.filter((group) => group.items.length > 0).map((group) => (
        <section key={group.kind} className="space-y-1">
          <h3 className="text-sm font-semibold text-text-strong">{t(`builder.conflict.${group.kind}`)}</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-text">
            {group.items.map((item) => <li key={item.label}>{item.label}</li>)}
          </ul>
        </section>
      ))}
    </FormDialog>
  )
}

export default function ConflictBanner() {
  const { t, i18n } = useTranslation('feedbackForms')
  const draft = useDraft()
  const sub = useAuthStore((state) => state.user?.sub)
  const [differences, setDifferences] = useState<readonly ConflictDifference[] | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  if (draft.conflict === null) return null
  const { updatedBy, updatedAt } = draft.conflict
  // The server names the saver by Cognito sub, never a name: only "you" (another tab) can be said, else someone else.
  const mine = updatedBy !== '' && updatedBy === sub
  const time = formatTime(updatedAt, i18n.language)
  const busy = draft.status.kind === 'saving'
  const compare = async () => {
    try {
      setDifferences(conflictDifferences(t, await draft.readTheirs(), draft.form))
      setReadFailed(false)
    } catch {
      setReadFailed(true)
    }
  }
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text lg:flex-row lg:items-center">
      <span className="flex flex-1 items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        <span>
          <span className="block font-medium text-text-strong">
            {mine && time !== '' ? t('builder.conflict.messageSelf', { time }) : t('builder.conflict.messageAnonymous')}
          </span>
          <span className="block">{t('builder.conflict.explain')}</span>
          {readFailed && <span className="block text-danger">{t('builder.conflict.readFailed')}</span>}
        </span>
      </span>
      <span className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { void compare() }}>{t('builder.conflict.compare')}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => saveIgnoringFailure(draft.loadTheirs)}>{t('builder.conflict.reload')}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => saveIgnoringFailure(draft.saveMine)}>{t('builder.conflict.saveMine')}</button>
      </span>
      <CompareSheet differences={differences} onClose={() => setDifferences(null)} />
    </div>
  )
}
