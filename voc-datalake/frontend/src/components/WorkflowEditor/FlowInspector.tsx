/**
 * @fileoverview The ONE inspector beside the flow canvas (7.52.00 C2; docs/ux part 5 §5.4, §5.6): a click (or Enter) on
 * a step opens its setup, in build, view or run, per KIND: Agent and Team (inspector/AgentInspector.tsx), Gate
 * (GateInspector), Calls a flow (CallFlowInspector), Trigger, End and Decision (TerminalInspectors), Platform
 * (PlatformInspector), and an arrow (EdgeInspector). Every one keeps "In this flow" (the step's own fields: edited
 * while building, text otherwise) apart from what is read only ("From the card", a gate's packs); Delete step is the
 * last control while building. An agents workflow's steps keep their editor's form (StepForm, arrows, loop) in the
 * same shell.
 *
 * Escape closes it and returns focus to the step on the canvas. The host decides where it sits: a 360 px docked
 * column from `lg`, the app's SideSheet below it (WorkflowEditor.tsx), the run workspace's inspector (Step view).
 *
 * @module components/WorkflowEditor/FlowInspector
 */
import { useState } from 'react'
import { ArrowRight, Boxes, Eye, ListChecks, Settings2, ShieldCheck, Users, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isEngineeringFlow } from '../../api/workflowsApi'
import { StepArrows } from './ArrowSettings'
import { LoopForm, StepLoop } from './LoopSettings'
import { InspectorShell } from './inspector/InspectorShell'
import { DeleteStep, StepForm } from './inspector/StepForm'
import { AgentInspector } from './inspector/AgentInspector'
import { GateInspector } from './inspector/GateInspector'
import { CallFlowInspector } from './inspector/CallFlowInspector'
import { CALL_TABS, agentTabs, gateTabs } from './inspector/inspectorTabs'
import { DecisionInspector, EndInspector, TriggerInspector } from './inspector/TerminalInspectors'
import { PlatformInspector } from './inspector/PlatformInspector'
import { EdgeInspector } from './inspector/EdgeInspector'
import { NodeTile } from './nodes/NodeParts'
import { kindOf } from './nodes/nodeKinds'
import { callLine, roleName } from './nodes/nodeText'
import { useFlowLookups } from './nodes/nodeData'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { WorkflowDefinition, WorkflowNode } from '../../api/workflowsApi'
import type { FlowSelection } from './FlowCanvas'
import type { FlowMode } from './nodes/nodeData'
import type { InspectorRun, KindViewProps } from './inspector/inspectorParts'

export interface FlowInspectorProps {
  readonly definition: WorkflowDefinition
  readonly mode: FlowMode
  /** What the canvas has selected (FlowCanvas `onSelect`); null or a lane: nothing to show. */
  readonly selection: FlowSelection
  /** Close (Escape, "Close inspector"): the host clears the selection. */
  readonly onClose?: () => void
  /** Build: the edited definition. */
  readonly onChange?: (definition: WorkflowDefinition) => void
  /** Build: inline validation messages per step id, and the ones of no step (a loop's). */
  readonly issuesByNode?: ReadonlyMap<string, readonly string[]>
  readonly generalIssues?: readonly string[]
  /** The scope a card's skill resolves to (an automation's connection; null: the shared skills). */
  readonly connection?: string | null
  /** The flow's own id when stored (its users, its expansion). */
  readonly workflowId?: string | null
  /** Run: what the run workspace knows (states, assertions, agents, checks, cards, the PR). */
  readonly run?: InspectorRun
  /** View: where an administrator edits the flow ("Edit in Flows"). */
  readonly editPath?: string | null
  /** The inspector opened from the keyboard: its heading takes focus. */
  readonly focusHeading?: boolean
}

const NO_ISSUES: readonly string[] = []
/** What a read-only inspector does with an edit: nothing (it offers none). */
function ignore(): void {
  // Nothing is edited outside build mode.
}

const TAB_ICONS: Readonly<Record<string, LucideIcon>> = {
  agents: Users, setup: Settings2, assertions: ListChecks, arrows: ArrowRight, checks: ShieldCheck, reviewers: Users,
  packs: Boxes, preview: Eye,
}

/** The kind's tabs in this mode (none: one panel). */
function tabsOf(node: WorkflowNode, mode: FlowMode): readonly string[] {
  if (node.type === 'agent' || node.type === 'board') return agentTabs(mode)
  if (node.type === 'quality_gate') return gateTabs(mode)
  return node.type === 'call_flow' ? CALL_TABS : []
}

/** "Agent · Fixer", "Gate · 3 rounds at most", "Calls a flow · Issue triage r2". */
function useKindLine(node: WorkflowNode): string {
  const { t } = useTranslation('agents')
  const { flows } = useFlowLookups()
  const kind = t(`canvas.kinds.${kindOf(node)}`)
  const params = node.data.params ?? {}
  if (node.type === 'agent') return `${kind} · ${roleName(t, params.role)}`
  if (node.type === 'quality_gate') return `${kind} · ${t('canvas.gate.rounds', { n: typeof params.max_rounds === 'number' ? params.max_rounds : 3 })}`
  if (node.type === 'call_flow') return `${kind} · ${callLine(t, params, flows)}`
  return kind
}

/** An engineering step's panel for its kind and tab. */
function EngineeringBody({ props, tab }: Readonly<{ props: KindViewProps; tab: string }>) {
  const { node } = props
  switch (node.type) {
    case 'agent':
    case 'board':
      return <AgentInspector props={props} tab={tab} />
    case 'quality_gate':
      return <GateInspector props={props} tab={tab} />
    case 'call_flow':
      return <CallFlowInspector props={props} tab={tab} />
    case 'start':
      return <TriggerInspector props={props} />
    case 'end':
      return kindOf(node) === 'decision' ? <DecisionInspector props={props} /> : <EndInspector props={props} />
    case 'stop_at_pr':
      return <EndInspector props={props} />
    default:
      return <PlatformInspector props={props} />
  }
}

/** An agents workflow's step: its editor's form, arrows and loop (read only through the same fields). */
function ProductBody({ props, generalIssues }: Readonly<{ props: KindViewProps; generalIssues: readonly string[] }>) {
  const { node, definition, mode, issues, onChange } = props
  const readOnly = mode !== 'build'
  return (
    <>
      <StepForm node={node} definition={definition} issues={issues} readOnly={readOnly} onChange={onChange} />
      <StepArrows definition={definition} node={node} readOnly={readOnly} onChange={onChange} />
      <StepLoop definition={definition} node={node} readOnly={readOnly} onChange={onChange} issues={generalIssues} />
    </>
  )
}

/** A run step's state chip beside its title. */
function StateChip({ run, nodeId }: Readonly<{ run: InspectorRun | undefined; nodeId: string }>) {
  const { t } = useTranslation('agents')
  const state = run?.states.get(nodeId)
  if (state === undefined) return null
  return <span className="badge badge-muted mt-1">{t(`run.stepStatus.${state.status}`)}</span>
}

/** What a kind's view of `node` takes, from the inspector's props. */
function kindViewOf(node: WorkflowNode, props: FlowInspectorProps): KindViewProps {
  return {
    node, definition: props.definition, mode: props.mode, issues: props.issuesByNode?.get(node.id) ?? NO_ISSUES,
    connection: props.connection ?? null, workflowId: props.workflowId ?? null, run: props.run, onChange: props.onChange ?? ignore,
  }
}

/** Close, then give the step on the canvas its focus back (Escape's way back). */
function closeAndRefocus(onClose: (() => void) | undefined, nodeId: string): (() => void) | undefined {
  if (onClose === undefined) return undefined
  return () => {
    onClose()
    // (a step's id is letters, digits, '_', '-' and '.': safe inside the quoted attribute)
    globalThis.document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)?.focus()
  }
}

function StepInspector({ node, props }: Readonly<{ node: WorkflowNode; props: FlowInspectorProps }>) {
  const { definition, mode, onChange, run } = props
  const tabs = tabsOf(node, mode)
  const [tab, setTab] = useState(tabs[0] ?? 'setup')
  const { t } = useTranslation('agents')
  const kindLine = useKindLine(node)
  const view = kindViewOf(node, props)
  const body: ReactNode = isEngineeringFlow(definition)
    ? <EngineeringBody props={view} tab={tab} /> : <ProductBody props={view} generalIssues={props.generalIssues ?? NO_ISSUES} />
  const shellTabs = tabs.length === 0 ? undefined
    : { ids: tabs, active: tab, icons: TAB_ICONS, onSelect: setTab, labelOf: (id: string) => t(`inspector.tab.${id}`) }
  return (
    <InspectorShell tile={<NodeTile step={node} kind={kindOf(node)} />} title={node.data.title} kindLine={kindLine} mode={mode}
      state={<StateChip run={run} nodeId={node.id} />} editPath={props.editPath} runRevision={run?.revision}
      focusHeading={props.focusHeading} onClose={closeAndRefocus(props.onClose, node.id)} tabs={shellTabs}>
      {body}
      {mode === 'build' && onChange !== undefined && <DeleteStep node={node} definition={definition} onChange={onChange} />}
    </InspectorShell>
  )
}

/** A loop of an agents workflow, in the shell. */
function LoopInspector({ index, props }: Readonly<{ index: number; props: FlowInspectorProps }>) {
  const { t } = useTranslation('agents')
  const tile = (
    <span aria-hidden="true" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted"><Workflow size={14} /></span>
  )
  return (
    <InspectorShell tile={tile} title={t('editor.loopTitle', { n: index + 1 })} kindLine={t('inspector.loop')} mode={props.mode} onClose={props.onClose}>
      <LoopForm definition={props.definition} index={index} readOnly={props.mode !== 'build'} onChange={props.onChange ?? ignore}
        issues={props.generalIssues ?? NO_ISSUES} />
    </InspectorShell>
  )
}

export function FlowInspector(props: Readonly<FlowInspectorProps>) {
  const { definition, selection } = props
  if (selection === null || selection.kind === 'lane') return null
  if (selection.kind === 'edge') {
    return (
      <EdgeInspector definition={definition} edgeId={selection.id} mode={props.mode} run={props.run}
        onChange={props.onChange ?? ignore} onClose={props.onClose} focusHeading={props.focusHeading} />
    )
  }
  if (selection.kind === 'loop') return <LoopInspector index={selection.index} props={props} />
  const node = definition.nodes.find((each) => each.id === selection.id)
  if (node === undefined) return null
  // (keyed by the step: a new step opens on its first tab)
  return <StepInspector key={node.id} node={node} props={props} />
}
