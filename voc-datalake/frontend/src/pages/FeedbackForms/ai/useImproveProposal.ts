/**
 * @fileoverview The Improve sheet's state (UX §12.2): the AI's proposal for the form as it is now, which of its
 * changes the person accepts and which addresses they checked, whether that combination may be applied (no new
 * problem, at least one change), and Apply: the accepted changes go into the draft (unsaved), the draft remembers the
 * AI changed it ("Undo AI changes" returns to the form before), and the changed cards carry the AI marker.
 *
 * @module pages/FeedbackForms/ai/useImproveProposal
 */
import { useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import type { DraftAnswer, DraftNote } from '../../../api/feedbackFormsV2Api'
import type { FormV2 } from '../model/formsV2'
import { effectiveChanges, formDiff } from '../model/formDiff'
import type { FormDiff } from '../model/formDiff'
import { applyChanges } from '../model/formDiffApply'
import { blockingProblems, validateForm } from '../model/validateForm'
import type { FormProblem } from '../model/validateForm'
import type { FormDraft } from '../builder/formDraftContext'
import { addressAt } from './aiAddresses'

export interface Proposal {
  readonly before: FormV2
  readonly after: FormV2
  readonly diff: FormDiff
  readonly notes: readonly DraftNote[]
  readonly warnings: readonly DraftNote[]
}

const problemKey = (problem: FormProblem) => `${problem.code}|${JSON.stringify(problem.at)}`

/** Why Apply is held, in words, or null when it may be pressed. */
function holdReason(t: TFunction<'feedbackForms'>, proposal: Proposal, effective: ReadonlySet<string>): string | null {
  if (effective.size === 0) return t('ai.diff.noneSelected')
  const result = applyChanges(proposal.before, proposal.after, proposal.diff, effective)
  const known = new Set(blockingProblems(validateForm(proposal.before)).map(problemKey))
  const fresh = blockingProblems(validateForm(result)).find((problem) => !known.has(problemKey(problem)))
  return fresh === undefined ? null : t('ai.diff.invalid', { problem: t(`problems.${fresh.code}`, fresh.params) })
}

export function useImproveProposal(draft: FormDraft, t: TFunction<'feedbackForms'>) {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set())
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const effective = useMemo(() => (proposal === null ? new Set<string>() : effectiveChanges(proposal.diff, accepted, checked)), [proposal, accepted, checked])
  const held = useMemo(() => (proposal === null ? null : holdReason(t, proposal, effective)), [t, proposal, effective])

  const propose = (before: FormV2, answer: DraftAnswer) => {
    const diff = formDiff(before, answer.form)
    setProposal({ before, after: answer.form, diff, notes: answer.notes, warnings: answer.warnings })
    setAccepted(new Set(diff.changes.map((change) => change.key)))
    setChecked(new Set())
  }

  /** Write the accepted changes into the draft; resolves to how many were applied. */
  const apply = (): number => {
    if (proposal === null || held !== null) return 0
    const result = applyChanges(proposal.before, proposal.after, proposal.diff, effective)
    const marked = proposal.diff.changes
      .filter((change) => effective.has(change.key) && change.kind !== 'removed' && (change.area === 'question' || change.area === 'ending'))
      .map((change) => change.id)
    draft.update(() => result)
    draft.setAi((current) => ({
      kind: 'improve', notes: proposal.notes, warnings: proposal.warnings, marked: new Set(marked), before: proposal.before, description: '',
      // (addresses an AI draft suggested earlier and the person has not confirmed stay errors; those checked here are confirmed)
      unconfirmed: (current?.unconfirmed ?? []).filter((location) => addressAt(result, location) !== ''),
    }))
    return effective.size
  }

  return { proposal, accepted, setAccepted, checked, setChecked, effective, held, propose, apply, reset: () => setProposal(null) }
}
