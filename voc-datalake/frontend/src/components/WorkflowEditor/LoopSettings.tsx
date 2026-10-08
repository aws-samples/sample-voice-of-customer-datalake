/**
 * @fileoverview Loop settings in the editor's side panel:
 * - {@link LoopForm}: one loop — exit condition (`until`), maximum rounds,
 *   member steps, its validation messages, and "Remove the loop". Shown when a
 *   loop frame is clicked (or focused + Enter) and under a member step;
 * - {@link StepLoop}: put the selected step into a new or an existing loop, or
 *   take it out of its loop.
 *
 * The values allowed are the server's (`lambda/shared/workflow_schema.py`):
 * `until` is persona_agreement | review_pass, `max_rounds` a whole number
 * 1–5, start / end steps never sit in a loop and a step is in one loop at most.
 *
 * @module components/WorkflowEditor/LoopSettings
 */
import { useState } from 'react'
import { Plus, Repeat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { API_WORKFLOW_LIMITS, WORKFLOW_LOOP_UNTIL } from '../../api/workflowsApi'
import { addToLoop, loopIndexOf, removeFromLoop, removeLoop, updateLoop } from './model'
import { clampRounds, loopIssues } from './loopFields'
import { LabeledField } from '../LabeledField/LabeledField'
import type { WorkflowDefinition, WorkflowLoop, WorkflowLoopUntil, WorkflowNode } from '../../api/workflowsApi'

interface LoopProps {
  definition: WorkflowDefinition
  readOnly: boolean
  onChange: (definition: WorkflowDefinition) => void
}

const loopable = (node: WorkflowNode): boolean => node.type !== 'start' && node.type !== 'end'

function LoopMembers({ definition, index, loop, readOnly, onChange, onIndexChange }: Readonly<LoopProps & {
  index: number; loop: WorkflowLoop; onIndexChange?: (index: number) => void
}>) {
  const { t } = useTranslation('agents')
  const toggle = (nodeId: string, member: boolean) => {
    if (member) {
      onChange(removeFromLoop(definition, nodeId))
      return
    }
    const next = addToLoop(definition, nodeId, index)
    onChange(next)
    // Joining can empty (and drop) an earlier loop, which shifts this loop's index; follow it.
    const moved = loopIndexOf(next, nodeId)
    if (moved >= 0 && moved !== index) onIndexChange?.(moved)
  }
  return (
    <fieldset className="space-y-1">
      <legend className="text-[12px] font-medium text-muted">{t('editor.loopStepsLegend')}</legend>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {definition.nodes.filter(loopable).map((node) => {
          const member = loop.node_ids.includes(node.id)
          const lastMember = member && loop.node_ids.length === 1
          return (
            <li key={node.id}>
              <label className="flex items-center gap-2 text-[13px] text-text">
                <input type="checkbox" className="accent-accent" checked={member} disabled={readOnly || lastMember}
                  onChange={() => toggle(node.id, member)} />
                <span className="truncate" title={node.data.title}>{node.data.title}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

export function LoopForm({ definition, index, readOnly, onChange, issues = [], onIndexChange }: Readonly<LoopProps & {
  index: number
  /** General validation messages; the ones about this loop are listed in the form. */
  issues?: readonly string[]
  onIndexChange?: (index: number) => void
}>) {
  const { t } = useTranslation('agents')
  const loop = definition.loops.at(index)
  if (loop === undefined) return null
  const mine = loopIssues(issues, index)
  return (
    <section className="space-y-3" aria-label={t('editor.loopTitle', { n: index + 1 })}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-aim">
        <Repeat size={14} aria-hidden="true" /> {t('editor.loopTitle', { n: index + 1 })}
        <span className="ml-auto font-normal text-muted">{t('editor.loopMembers', { n: loop.node_ids.length })}</span>
      </p>
      {mine.length > 0 && (
        <ul className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger space-y-0.5" aria-live="polite">
          {mine.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <LabeledField label={t('editor.fields.until')} hint={t(`loopUntilHint.${loop.until}`)}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={loop.until}
            onChange={(e) => {
              const until: WorkflowLoopUntil | undefined = WORKFLOW_LOOP_UNTIL.find((u) => u === e.target.value)
              if (until !== undefined) onChange(updateLoop(definition, index, { until }))
            }}>
            {WORKFLOW_LOOP_UNTIL.map((u) => <option key={u} value={u}>{t(`loopUntil.${u}`)}</option>)}
          </select>
        )}
      </LabeledField>
      <LabeledField label={t('editor.fields.maxRounds')}
        hint={t('editor.maxRoundsHint', { min: API_WORKFLOW_LIMITS.minRounds, max: API_WORKFLOW_LIMITS.maxRounds })}>
        {(id) => (
          <input id={id} type="number" inputMode="numeric" step={1} className="input w-full" disabled={readOnly}
            min={API_WORKFLOW_LIMITS.minRounds} max={API_WORKFLOW_LIMITS.maxRounds} value={loop.max_rounds}
            onChange={(e) => onChange(updateLoop(definition, index, { max_rounds: clampRounds(e.target.value) }))} />
        )}
      </LabeledField>
      <LoopMembers definition={definition} index={index} loop={loop} readOnly={readOnly} onChange={onChange} onIndexChange={onIndexChange} />
      {!readOnly && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(removeLoop(definition, index))}>
          {t('editor.ungroupLoop')}
        </button>
      )}
    </section>
  )
}

const NEW_LOOP = 'new'

/** Loop membership of one step: join a loop (new or existing), or leave it. */
export function StepLoop({ definition, node, readOnly, onChange, issues }: Readonly<LoopProps & {
  node: WorkflowNode; issues?: readonly string[]
}>) {
  const { t } = useTranslation('agents')
  const [choice, setChoice] = useState(NEW_LOOP)
  if (!loopable(node)) return null
  const index = loopIndexOf(definition, node.id)
  if (index >= 0) {
    return (
      <div className="space-y-3 border-t border-border pt-3">
        <LoopForm definition={definition} index={index} readOnly={readOnly} onChange={onChange} issues={issues} />
        {!readOnly && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(removeFromLoop(definition, node.id))}>
            {t('editor.leaveLoop')}
          </button>
        )}
      </div>
    )
  }
  if (readOnly) return null
  const join = () => onChange(addToLoop(definition, node.id, choice === NEW_LOOP ? 'new' : Number(choice)))
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <LabeledField label={t('editor.fields.joinLoop')} hint={t('editor.joinLoopHint')}>
        {(id) => (
          <select id={id} className="select w-full" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value={NEW_LOOP}>{t('editor.newLoop')}</option>
            {definition.loops.map((loop, i) => (
              <option key={loop.node_ids.join('|')} value={String(i)}>{t('editor.loopOption', { n: i + 1, count: loop.node_ids.length })}</option>
            ))}
          </select>
        )}
      </LabeledField>
      <button type="button" className="btn btn-secondary btn-sm" onClick={join}>
        <Plus size={14} aria-hidden="true" /> {t('editor.joinLoop')}
      </button>
    </div>
  )
}
