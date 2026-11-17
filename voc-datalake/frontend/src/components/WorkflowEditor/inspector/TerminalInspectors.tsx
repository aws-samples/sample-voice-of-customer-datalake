/**
 * @fileoverview The Trigger, End and Decision inspectors (7.52.00 C2; docs/ux part 5 §5.4):
 * - **Trigger (Start):** who starts it (the automations that run the flow, "Used by"), the inputs it declares
 *   (`definition.inputs`), and Start's own settings, stored on its params and shown nowhere before (N4): memory
 *   recall, the built-in Learn (on or off, its model, share, roles, how long a person has before Learn reads a run
 *   at a person, and its assertions) and the pull request's state (ready for review or a draft). Edited while
 *   building.
 * - **End / Stop at PR:** what happens there (nothing is ever merged), the pull request's state from Start, and in a
 *   run the pull request it opened.
 * - **Decision:** what happens (the run stops and waits for a person), where it is reached from, and what Learn does
 *   if nobody decides; only the title is edited.
 *
 * @module components/WorkflowEditor/inspector/TerminalInspectors
 */
import { useTranslation } from 'react-i18next'
import { definitionInputs } from '../../../api/workflowsApi'
import { isRecord } from '../../../lib/typeGuards'
import { LabeledField } from '../../LabeledField/LabeledField'
import { flowPrState, modelShortName, roleName } from '../nodes/nodeText'
import { AssertionsField } from './AssertionsField'
import { Facts, SectionHeading } from './InspectorShell'
import { InThisFlow } from './inspectorParts'
import { setParams } from './stepEdits'
import { useFlowUsage } from './useFlowSetup'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { KindViewProps } from './inspectorParts'
import type { FlowInput } from '../../../api/workflowsApi'

type Params = Readonly<Record<string, unknown>>

const recordOf = (value: unknown): Params => (isRecord(value) ? value : {})

/** Start's Learn and memory as the server reads them when left out (`workflow_engineering.py flow_settings`). */
function startSettings(params: Params): { recall: boolean; learn: Params; pr: string } {
  const memory = recordOf(params.memory)
  const learn = isRecord(params.learn) ? params.learn : { enabled: true }
  return { recall: memory.recall === true, learn, pr: params.pr === 'draft' ? 'draft' : 'ready' }
}

function learnLine(t: TFunction<'agents'>, learn: Params): string {
  if (learn.enabled !== true) return t('inspector.trigger.learnOff')
  const parts = [
    typeof learn.model === 'string' ? modelShortName(learn.model) : '',
    typeof learn.budget_share === 'number' ? t('canvas.chips.share', { percent: Math.round(learn.budget_share * 100) }) : '',
    Array.isArray(learn.roles) ? t('inspector.trigger.roles', { count: learn.roles.length }) : '',
    t('inspector.trigger.after', { hours: typeof learn.after_needs_human_hours === 'number' ? learn.after_needs_human_hours : 72 }),
  ].filter((part) => part !== '')
  return [t('inspector.trigger.learnOn'), ...parts].join(' · ')
}

/** Building: memory recall, Learn on or off, the pull request's state. */
function StartFields({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { node, definition, onChange } = props
  const params = node.data.params ?? {}
  const { recall, learn, pr } = startSettings(params)
  const write = (key: string, value: unknown) => onChange(setParams(definition, node.id, (current) => ({ ...current, [key]: value })))
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={recall}
          onChange={(e) => write('memory', { ...recordOf(params.memory), recall: e.target.checked })} />
        {t('inspector.trigger.recall')}
      </label>
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={learn.enabled === true} onChange={(e) => write('learn', { ...learn, enabled: e.target.checked })} />
        {t('inspector.trigger.learnEnabled')}
      </label>
      <LabeledField label={t('inspector.trigger.pr')}>
        {(id) => (
          <select id={id} className="select w-full" value={pr} onChange={(e) => write('pr', e.target.value)}>
            <option value="ready">{t('inspector.trigger.prReady')}</option>
            <option value="draft">{t('inspector.trigger.prDraft')}</option>
          </select>
        )}
      </LabeledField>
    </div>
  )
}

/** A declared input in words ("feedback, at most 50"). */
function inputWords(t: TFunction<'agents'>, input: FlowInput): string {
  return input.max === null ? input.name : t('inspector.trigger.inputMax', { name: input.name, max: input.max })
}

export function TriggerInspector({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { node, definition, mode, workflowId, onChange } = props
  const usage = useFlowUsage(workflowId)
  const params = node.data.params ?? {}
  const { recall, learn, pr } = startSettings(params)
  const inputs = definitionInputs(definition)
  const names = usage.usedBy.automations.map((automation) => automation.name)
  const engineering = definition.schema === 'voc-workflow/2'
  return (
    <>
      <Facts rows={[
        [t('inspector.trigger.startedBy'), names.length === 0 ? t('inspector.trigger.nobody') : names.join(', ')],
        inputs.length === 0 ? null : [t('inspector.trigger.inputs'), inputs.map((input) => inputWords(t, input)).join(' · ')],
      ]} />
      <InThisFlow props={props}
        rows={engineering ? [
          [t('inspector.trigger.memory'), t(recall ? 'inspector.trigger.recallOn' : 'inspector.trigger.recallOff')],
          [t('inspector.trigger.learn'), learnLine(t, learn)],
          [t('inspector.trigger.pr'), t(pr === 'draft' ? 'inspector.trigger.prDraft' : 'inspector.trigger.prReady')],
        ] : []}
        extras={engineering ? <StartFields props={props} /> : undefined} />
      {engineering && (
        <section className="space-y-2">
          <SectionHeading>{t('inspector.trigger.learnAssertions')}</SectionHeading>
          <AssertionsField place="learn" value={learn.assert} mode={mode}
            onChange={(next) => onChange(setParams(definition, node.id, (current) => {
              const rest = Object.fromEntries(Object.entries(learn).filter(([key]) => key !== 'assert'))
              return { ...current, learn: next.length === 0 ? rest : { ...rest, assert: next } }
            }))} />
        </section>
      )}
      {engineering && learn.enabled === true && Array.isArray(learn.roles) && (
        <p className="text-[12px] text-muted">{learn.roles.map((role: unknown) => roleName(t, role)).join(', ')}</p>
      )}
    </>
  )
}

export function EndInspector({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { node, definition, run } = props
  const pr = flowPrState(definition.nodes)
  const pull = run?.pullRequest ?? null
  const rows: ReadonlyArray<readonly [string, ReactNode] | null> = [
    [t('inspector.end.happens'), t(node.type === 'stop_at_pr' ? 'inspector.end.stopAtPr' : 'inspector.end.completed')],
    node.type === 'stop_at_pr' ? [t('inspector.trigger.pr'), t(pr === 'draft' ? 'inspector.trigger.prDraft' : 'inspector.trigger.prReady')] : null,
    pull === null ? null : [t('inspector.end.pullRequest'), <a key="pr" href={pull.url} target="_blank" rel="noreferrer" className="link">{t('inspector.end.prNumber', { n: pull.number })}</a>],
  ]
  return (
    <>
      <Facts rows={rows} />
      <InThisFlow props={props} />
    </>
  )
}

export function DecisionInspector({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { node, definition, run } = props
  const title = (id: string) => definition.nodes.find((each) => each.id === id)?.data.title ?? id
  const from = definition.edges.filter((edge) => edge.target === node.id)
    .map((edge) => (edge.label === undefined ? title(edge.source)
      : t('inspector.decision.fromVerdict', { step: title(edge.source), verdict: t(`edgeLabels.${edge.label}`) })))
  const start = definition.nodes.find((each) => each.type === 'start')
  const hours = recordOf(recordOf(start?.data.params).learn).after_needs_human_hours
  const waiting = run?.states.get(node.id)?.status === 'waiting'
  return (
    <>
      <Facts rows={[
        [t('inspector.decision.happens'), t('inspector.decision.happensText')],
        from.length === 0 ? null : [t('inspector.decision.reachedFrom'), from.join(', ')],
        [t('inspector.decision.ifNobody'), t('inspector.decision.ifNobodyText', { hours: typeof hours === 'number' ? hours : 72 })],
      ]} />
      {waiting && <p className="badge badge-warn">{t('canvas.state.waitingForYou')}</p>}
      <InThisFlow props={props} />
    </>
  )
}
