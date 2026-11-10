/**
 * @fileoverview The admin's decision on a run that stopped for a person: a
 * choice of what happens next (only the ones the server allows, `run.actions`),
 * then one "Make the decision" button.
 *
 * - **Fix the objections I pick** (`another_round`): the persona objections as
 *   checkboxes (a blocking persona's ticked by default) plus optional
 *   instructions, sent as the note the next revision reads.
 * - **Accept as it is and continue** (`accept`).
 * - **Something else** (`another_round`): the admin's own instructions only.
 * - **Close the run** (`stop`), confirmed first: it cannot be undone.
 *
 * @module pages/Agents/RunDecisionForm
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { MAX_DECISION_NOTE_CHARS } from '../../api/agentRunDecision'
import { blockingKeys, buildDecisionNote, objectionsByPersona, objectionsOf } from './decisionNote'
import { useAgentMutations } from './useAgents'
import type { AgentRun } from '../../api/agentsApi'
import type { RunDecisionKind } from '../../api/agentRunDecision'
import type { PersonaObjections, PickableObjection } from './decisionNote'

type Choice = 'fix' | 'accept' | 'other' | 'stop'

const DECISION_OF: Record<Choice, RunDecisionKind> = { fix: 'another_round', accept: 'accept', other: 'another_round', stop: 'stop' }

/** The choices the server's `actions` allow, in the order they are offered. */
function choicesFor(actions: readonly RunDecisionKind[], hasObjections: boolean): Choice[] {
  const round = actions.includes('another_round')
  const offered: Record<Choice, boolean> = {
    fix: round && hasObjections, accept: actions.includes('accept'), other: round, stop: actions.includes('stop'),
  }
  const order: readonly Choice[] = ['fix', 'accept', 'other', 'stop']
  return order.filter((c) => offered[c])
}

function ObjectionPicker({ groups, picked, onToggle }: Readonly<{
  groups: readonly PersonaObjections[]; picked: ReadonlySet<string>; onToggle: (key: string) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-medium text-muted">{t('decision.form.pickObjections')}</legend>
      {groups.map((group) => (
        <div key={group.objections[0]?.key ?? group.persona} className="space-y-1">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-text-strong">
            {group.persona}
            {group.blocking && <span className="badge badge-danger">{t('decision.blocking')}</span>}
          </p>
          {group.objections.map((o) => (
            <label key={o.key} className="flex items-start gap-2 text-[12px] text-text">
              <input type="checkbox" className="mt-0.5" checked={picked.has(o.key)} onChange={() => onToggle(o.key)} />
              <span className="min-w-0 break-words">{o.text}</span>
            </label>
          ))}
        </div>
      ))}
    </fieldset>
  )
}

function Instructions({ value, onChange, required }: Readonly<{ value: string; onChange: (v: string) => void; required: boolean }>) {
  const { t } = useTranslation('agents')
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">
        {t(required ? 'decision.form.instructionsRequired' : 'decision.form.instructions')}
      </label>
      <textarea id={id} rows={3} className="input w-full" value={value} maxLength={MAX_DECISION_NOTE_CHARS}
        placeholder={t('decision.form.instructionsPlaceholder')} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/** One option: its radio, what it does, and (while chosen) its own fields. */
function ChoiceOption({ choice, chosen, name, node, onChoose, children }: Readonly<{
  choice: Choice; chosen: boolean; name: string; node: string; onChoose: () => void; children?: ReactNode
}>) {
  const { t } = useTranslation('agents')
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 space-y-2">
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="radio" name={name} className="mt-1" checked={chosen} onChange={onChoose} />
        <span>
          <span className="block text-sm font-medium text-text-strong">{t(`decision.form.${choice}.label`, { node })}</span>
          <span className="block text-[12px] text-muted">{t(`decision.form.${choice}.help`, { node })}</span>
        </span>
      </label>
      {chosen && children !== undefined && <div className="pl-6 space-y-2">{children}</div>}
    </div>
  )
}

/** The decision a choice sends, or null while it is incomplete. */
function decisionOf(choice: Choice | null, picked: readonly PickableObjection[], instructions: string): { decision: RunDecisionKind; note: string } | null {
  if (choice === null) return null
  const note = choice === 'fix' ? buildDecisionNote(picked, instructions) : instructions.trim()
  if ((choice === 'fix' || choice === 'other') && note === '') return null
  return { decision: DECISION_OF[choice], note: choice === 'stop' ? '' : note }
}

export function RunDecisionForm({ agentId, run }: Readonly<{ agentId: string; run: AgentRun }>) {
  const { t } = useTranslation('agents')
  const { decideRun } = useAgentMutations(agentId)
  const verdicts = run.needs_human?.verdicts
  const objections = useMemo(() => objectionsOf(verdicts ?? []), [verdicts])
  const groups = useMemo(() => objectionsByPersona(verdicts ?? []), [verdicts])
  const choices = choicesFor(run.actions, objections.length > 0)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => blockingKeys(objections))
  const [instructions, setInstructions] = useState('')
  const [confirmStop, setConfirmStop] = useState(false)
  const name = useId()
  const node = run.needs_human?.node_title ?? ''
  const chosen = decisionOf(choice, objections.filter((o) => picked.has(o.key)), instructions)
  const send = () => {
    if (chosen === null) return
    decideRun.mutate({ runId: run.run_id, decision: chosen.decision, ...(chosen.note === '' ? {} : { note: chosen.note }) },
      { onSettled: () => setConfirmStop(false) })
  }
  const toggle = (key: string) => setPicked((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  // The fields an option shows while it is chosen (accept and stop need none).
  const fields: Partial<Record<Choice, ReactNode>> = {
    fix: (
      <>
        <ObjectionPicker groups={groups} picked={picked} onToggle={toggle} />
        <Instructions value={instructions} onChange={setInstructions} required={false} />
      </>
    ),
    other: <Instructions value={instructions} onChange={setInstructions} required />,
  }
  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-text-strong">{t('decision.form.question')}</legend>
        {choices.map((c) => (
          <ChoiceOption key={c} choice={c} chosen={choice === c} name={name} node={node} onChoose={() => setChoice(c)}>
            {fields[c]}
          </ChoiceOption>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={chosen === null || decideRun.isPending}
          onClick={() => (choice === 'stop' ? setConfirmStop(true) : send())}>
          {decideRun.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
          {t('decision.form.submit')}
        </button>
        {choice !== null && chosen === null && <span className="text-[12px] text-muted">{t(`decision.form.${choice}.incomplete`)}</span>}
      </div>
      {decideRun.isError && (
        <p role="alert" className="text-[12px] text-danger">
          {apiErrorStatus(decideRun.error) === 409 ? t('decision.conflict') : t('decision.failed')}
        </p>
      )}
      <ConfirmModal isOpen={confirmStop} title={t('decision.stopTitle')} message={t('decision.stopMessage')}
        confirmLabel={t('decision.stop')} cancelLabel={t('common.cancel')} variant="warning"
        isLoading={decideRun.isPending} onConfirm={send} onCancel={() => setConfirmStop(false)} />
    </div>
  )
}
