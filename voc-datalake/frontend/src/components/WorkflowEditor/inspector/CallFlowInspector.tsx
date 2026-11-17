/**
 * @fileoverview The "Calls a flow" inspector (7.52.00 `call_flow`; docs/ux part 5 §5.4): Setup and Preview.
 * - **In this flow:** the flow it calls and the revision it pins (a saved engineering flow; the library's other
 *   ones, never one that calls this flow), the inputs that flow declares (`definition.inputs`, each given text of at
 *   most 200 characters), its share of each run's budget; read as text outside building.
 * - What calling it makes: the child's steps, this flow's expansion (`GET /workflows/<id>/expanded`: "Expands to 6
 *   steps · 14 of 60 steps in all", or the server's refusal in words), who uses this flow, and Open flow.
 * - **Preview:** the child at its revision, drawn by the same canvas, read only.
 *
 * @module components/WorkflowEditor/inspector/CallFlowInspector
 */
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { API_WORKFLOW_LIMITS, definitionInputs, parseFlowRef } from '../../../api/workflowsApi'
import { workflowPath } from '../../../pages/Agents/workflowPaths'
import { LabeledField } from '../../LabeledField/LabeledField'
import { FlowCanvas } from '../FlowCanvas'
import { Facts, SectionHeading, SectionLoading } from './InspectorShell'
import { InThisFlow } from './inspectorParts'
import { setParams } from './stepEdits'
import { CALL_TABS } from './inspectorTabs'
import type { CallTab } from './inspectorTabs'
import { useExpandedFlow, useFlowLibrary, useFlowRevision, useFlowUsage } from './useFlowSetup'
import type { TFunction } from 'i18next'
import type { WorkflowDefinition, WorkflowSummary } from '../../../api/workflowsApi'
import type { KindViewProps } from './inspectorParts'

type FlowRef = { readonly workflowId: string; readonly revision: number }

/** A call's inputs as stored (`params.inputs`: name → text). */
function inputsOf(params: Readonly<Record<string, unknown>>): Record<string, string> {
  const raw = params.inputs
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** The library's engineering flows a call may name: active, not this one, not one that calls it. */
function callable(flows: readonly WorkflowSummary[], self: string | null, callers: ReadonlySet<string>): WorkflowSummary[] {
  return flows.filter((flow) => flow.kind === 'engineering' && flow.status === 'active' && flow.workflow_id !== self
    && !callers.has(flow.workflow_id))
}

function FlowPicker({ props, flowRef }: Readonly<{ props: KindViewProps; flowRef: FlowRef | null }>) {
  const { t } = useTranslation('agents')
  const { node, definition, workflowId, onChange } = props
  const library = useFlowLibrary()
  const usage = useFlowUsage(workflowId)
  const callers = new Set(usage.usedBy.flows.map((flow) => flow.workflow_id))
  const flows = callable(library.data ?? [], workflowId, callers)
  const chosen = flows.find((flow) => flow.workflow_id === flowRef?.workflowId)
  const write = (id: string, revision: number) =>
    onChange(setParams(definition, node.id, (current) => ({ ...current, flow: `${id}@${revision}`, inputs: undefined })))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
      <LabeledField label={t('inspector.call.flow')}>
        {(id) => (
          <select id={id} className="select w-full" value={flowRef?.workflowId ?? ''}
            onChange={(e) => {
              const flow = flows.find((each) => each.workflow_id === e.target.value)
              if (flow !== undefined) write(flow.workflow_id, flow.revision)
            }}>
            {flowRef === null && <option value="">—</option>}
            {flowRef !== null && chosen === undefined && <option value={flowRef.workflowId}>{flowRef.workflowId}</option>}
            {flows.map((flow) => <option key={flow.workflow_id} value={flow.workflow_id}>{flow.name}</option>)}
          </select>
        )}
      </LabeledField>
      <LabeledField label={t('inspector.call.revision')}>
        {(id) => (
          <select id={id} className="select w-full" value={flowRef?.revision ?? ''} disabled={flowRef === null}
            onChange={(e) => { if (flowRef !== null) write(flowRef.workflowId, Number(e.target.value)) }}>
            {Array.from({ length: Math.max(chosen?.revision ?? 0, flowRef?.revision ?? 0) }, (_each, at) => at + 1).reverse()
              .map((revision) => <option key={revision} value={revision}>{t('palette.revision', { n: revision })}</option>)}
          </select>
        )}
      </LabeledField>
    </div>
  )
}

/** The inputs the called flow declares, each given its text (build) or read (else). */
function CallInputs({ props, child }: Readonly<{ props: KindViewProps; child: WorkflowDefinition | null }>) {
  const { t } = useTranslation('agents')
  const { node, definition, mode, onChange } = props
  const given = inputsOf(node.data.params ?? {})
  const declared = child === null ? [] : definitionInputs(child)
  if (declared.length === 0) return <p className="text-[12px] text-muted">{t('inspector.call.noInputs')}</p>
  if (mode !== 'build') return <Facts rows={declared.map((input) => [input.name, given[input.name] ?? t('inspector.call.inputUnset')] as const)} />
  const set = (name: string, text: string) => onChange(setParams(definition, node.id, (current) => {
    const next = { ...inputsOf(current), [name]: text }
    const kept = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== ''))
    return { ...current, inputs: Object.keys(kept).length === 0 ? undefined : kept }
  }))
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-medium text-muted">{t('inspector.call.inputs')}</legend>
      {declared.map((input) => (
        <LabeledField key={input.name} label={input.required ? t('inspector.call.inputRequired', { name: input.name }) : input.name}
          hint={input.description === '' ? undefined : input.description}>
          {(id) => <input id={id} className="input w-full" maxLength={200} value={given[input.name] ?? ''} onChange={(e) => set(input.name, e.target.value)} />}
        </LabeledField>
      ))}
    </fieldset>
  )
}

/** What calling it makes: the child's steps, this flow's expansion (or its refusal), who uses this flow, Open flow. */
function Expansion({ props, flowRef, child }: Readonly<{
  props: KindViewProps; flowRef: FlowRef | null; child: WorkflowDefinition | null
}>) {
  const { t } = useTranslation('agents')
  const expanded = useExpandedFlow(props.workflowId, null)
  const usage = useFlowUsage(props.workflowId)
  const names = usage.usedBy.automations.map((automation) => automation.name)
  return (
    <section className="space-y-2" aria-label={t('inspector.call.expands')}>
      <Facts rows={[
        child === null ? null : [t('inspector.call.steps'), t('inspector.call.childSteps', { count: child.nodes.length })],
        expanded.data === undefined ? null
          : [t('inspector.call.expands'), t('inspector.call.inAll', { total: expanded.data.steps, max: API_WORKFLOW_LIMITS.maxNodes })],
        names.length === 0 ? null : [t('inspector.call.usedBy'), names.join(', ')],
      ]} />
      {expanded.isError && <p role="note" className="rounded-md bg-danger-subtle px-2 py-1.5 text-[12px] text-text">{expanded.error.message}</p>}
      {flowRef !== null && (
        <Link to={workflowPath(flowRef.workflowId)} className="btn btn-ghost btn-sm">
          {t('inspector.call.openFlow')} <ExternalLink size={12} aria-hidden="true" />
        </Link>
      )}
    </section>
  )
}

/** The child at its revision, drawn by the same canvas, read only. */
function CallPreview({ child }: Readonly<{ child: ReturnType<typeof useFlowRevision> }>) {
  const { t } = useTranslation('agents')
  const definition = child.data?.definition ?? null
  if (child.isLoading) return <SectionLoading />
  if (definition === null) return <p className="text-sm text-muted">{t('inspector.call.noPreview')}</p>
  return (
    <div className="card h-[200px] overflow-hidden p-0">
      <FlowCanvas definition={definition} mode="view" label={t('inspector.call.preview', { name: child.data?.name ?? '' })} />
    </div>
  )
}

/** The call's rows as text: the flow it calls at its revision, and its share. */
function callRows(t: TFunction<'agents'>, params: Readonly<Record<string, unknown>>, flowRef: FlowRef | null, childName: string | undefined) {
  const share = params.budget_share
  return [
    [t('inspector.call.flow'), flowRef === null ? t('canvas.call.noFlow')
      : t('canvas.call.line', { name: childName ?? flowRef.workflowId, revision: flowRef.revision })] as const,
    typeof share === 'number' ? [t('inspector.agent.share'), t('canvas.chips.share', { percent: Math.round(share * 100) })] as const : null,
  ]
}

export function CallFlowInspector({ props, tab: asked }: Readonly<{ props: KindViewProps; tab: string }>) {
  const { t } = useTranslation('agents')
  const tab: CallTab = CALL_TABS.find((id) => id === asked) ?? 'setup'
  const params = props.node.data.params ?? {}
  const flowRef = parseFlowRef(params.flow)
  const child = useFlowRevision(flowRef?.workflowId ?? null, flowRef?.revision ?? null)
  const childDefinition = child.data?.definition ?? null
  if (tab === 'preview') return <CallPreview child={child} />
  return (
    <>
      <InThisFlow props={props} rows={callRows(t, params, flowRef, child.data?.name)}
        extras={<FlowPicker props={props} flowRef={flowRef} />} />
      <section className="space-y-2">
        <SectionHeading>{t('inspector.call.inputs')}</SectionHeading>
        <CallInputs props={props} child={childDefinition} />
      </section>
      {props.mode !== 'run' && <Expansion props={props} flowRef={flowRef} child={childDefinition} />}
    </>
  )
}
