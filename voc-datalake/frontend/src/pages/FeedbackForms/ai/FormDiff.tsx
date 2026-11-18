/**
 * @fileoverview The AI's changes as a diff to accept or reject (UX §12.2): the model's notes and warnings, and what
 * it changed outside what it may (ignored), in the `aim` box; Accept all / Reject all; one row per change, keyed by
 * id. The combination the person picks is checked live: a form left with a new problem holds Apply (the sheet
 * says why).
 *
 * @module pages/FeedbackForms/ai/FormDiff
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Sparkles } from 'lucide-react'
import type { DraftNote } from '../../../api/feedbackFormsV2Api'
import type { FormV2 } from '../model/formsV2'
import type { FormChange, FormDiff as Diff } from '../model/formDiff'
import { rulesTo } from '../model/formDiffApply'
import FormChangeRow from './FormChangeRow'

function AimBox({ notes, warnings, ignored }: Readonly<{ notes: readonly DraftNote[]; warnings: readonly DraftNote[]; ignored: string | null }>) {
  const { t } = useTranslation('feedbackForms')
  if (notes.length === 0 && warnings.length === 0 && ignored === null) return null
  return (
    <div className="space-y-1.5 rounded-md border border-aim/30 bg-aim-subtle p-3 text-[13px] text-text">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-aim">
        <Sparkles size={12} aria-hidden="true" />{t('ai.diff.fromAi')}
      </p>
      {notes.map((note) => <p key={note.message}>{note.message}</p>)}
      {warnings.map((warning) => (
        <p key={warning.message} className="flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />{warning.message}
        </p>
      ))}
      {ignored !== null && <p className="text-muted">{ignored}</p>}
    </div>
  )
}

/** What goes with a rejected change: the rules to a question or ending that is not added, or kept with a kept one. */
function useDependency(before: FormV2, after: FormV2) {
  const { t } = useTranslation('feedbackForms')
  const list = (numbers: readonly number[]) => numbers.join(', ')
  return (change: FormChange): string | null => {
    if (change.area !== 'question' && change.area !== 'ending') return null
    if (change.kind === 'added') {
      const numbers = rulesTo(after, change.id)
      return numbers.length === 0 ? null : t('ai.diff.notAppliedWith', { questions: list(numbers) })
    }
    if (change.kind === 'removed') {
      const numbers = rulesTo(before, change.id)
      return numbers.length === 0 ? null : t('ai.diff.keptWith', { questions: list(numbers) })
    }
    return null
  }
}

export default function FormDiff({ before, after, diff, notes, warnings, accepted, onAccepted, checked, onChecked }: Readonly<{
  before: FormV2
  after: FormV2
  diff: Diff
  notes: readonly DraftNote[]
  warnings: readonly DraftNote[]
  accepted: ReadonlySet<string>
  onAccepted: (accepted: ReadonlySet<string>) => void
  checked: ReadonlySet<string>
  onChecked: (checked: ReadonlySet<string>) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const dependency = useDependency(before, after)
  const toggle = (set: ReadonlySet<string>, key: string, on: boolean): Set<string> => {
    const next = new Set(set)
    if (on) next.add(key)
    else next.delete(key)
    return next
  }
  const ignored = diff.ignored.length === 0 ? null
    : t('ai.diff.ignored', { areas: diff.ignored.map((area) => t(`ai.diff.ignoredAreas.${area}`)).join(', ') })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">
          {t('ai.diff.title')} <span className="font-normal text-muted">· {t('ai.diff.count', { count: diff.changes.length })}</span>
        </h3>
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAccepted(new Set(diff.changes.map((change) => change.key)))}>{t('ai.diff.acceptAll')}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAccepted(new Set())}>{t('ai.diff.rejectAll')}</button>
        </div>
      </div>
      <AimBox notes={notes} warnings={warnings} ignored={ignored} />
      <ul className="space-y-2" aria-label={t('ai.diff.title')}>
        {diff.changes.map((change) => (
          <FormChangeRow key={change.key} change={change} before={before} after={after}
            accepted={accepted.has(change.key)} onAccept={(on) => onAccepted(toggle(accepted, change.key, on))}
            expanded={expanded.has(change.key)} onExpand={(on) => setExpanded(toggle(expanded, change.key, on))}
            checked={checked} onCheck={(url, on) => onChecked(toggle(checked, url, on))} dependency={dependency(change)} />
        ))}
      </ul>
    </div>
  )
}
