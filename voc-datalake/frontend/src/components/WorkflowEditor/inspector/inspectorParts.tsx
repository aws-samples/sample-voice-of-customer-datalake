/**
 * @fileoverview What every kind's inspector shares (7.52.00 C2): the props a kind's view takes, a step's settings
 * written back (`setParams`), its own fields as read-only text ("In this flow" outside building), its arrows in words,
 * and the "In this flow" section while building (StepForm, then the kind's extras).
 *
 * @module components/WorkflowEditor/inspector/inspectorParts
 */
import { useTranslation } from 'react-i18next'
import { StepArrows } from '../ArrowSettings'
import { Facts, SectionHeading } from './InspectorShell'
import { StepForm } from './StepForm'
import { AssertionsField } from './AssertionsField'
import { withAssertions } from './stepEdits'
import type { ReactNode } from 'react'
import type { RunAssertion } from '../../../api/engineeringRunWorkspaceApi'
import type { WorkflowDefinition, WorkflowNode } from '../../../api/workflowsApi'
import type { FlowMode } from '../nodes/nodeData'
import type { StepState } from '../runState'

/** What a run gives the inspector (the run workspace's reads, so the inspector names no run route). */
export interface InspectorRun {
  /** The revision of the run's copy. */
  readonly revision: number | null
  /** Each step's state, as the canvas lit it. */
  readonly states: ReadonlyMap<string, StepState>
  /** The run's assertions (each step's are its own). */
  readonly assertions?: readonly RunAssertion[]
  /** A step's agents: its lanes, each with its state, cost and Open session (the run workspace draws it). */
  readonly agentsOf?: (step: string) => ReactNode
  /** A gate step's checks, reviewers and final go (the run workspace reads the gate runner's gate). */
  readonly checksOf?: (step: string) => ReactNode
  /** The card (and version) an agent step ran, from the overview's agents (gap L); null: its role's. */
  readonly cardOf?: (step: string) => { readonly card: string; readonly version: number | null } | null
  /** The run's pull request, when it opened one. */
  readonly pullRequest?: { readonly number: number; readonly url: string } | null
}

/** What every kind's view of one step takes. */
export interface KindViewProps {
  readonly node: WorkflowNode
  readonly definition: WorkflowDefinition
  readonly mode: FlowMode
  readonly issues: readonly string[]
  /** The scope whose skill heads a card resolves to (null: the shared skills). */
  readonly connection: string | null
  /** The flow's own id (who uses it, its expansion), when stored. */
  readonly workflowId: string | null
  readonly run?: InspectorRun
  readonly onChange: (definition: WorkflowDefinition) => void
}

/** A step's own fields as text: its title and instructions, then the kind's rows. */
export function StepFacts({ node, rows = [] }: Readonly<{ node: WorkflowNode; rows?: ReadonlyArray<readonly [string, ReactNode] | null> }>) {
  const { t } = useTranslation('agents')
  return (
    <Facts rows={[
      [t('editor.fields.title'), node.data.title],
      ...rows,
      node.data.instructions === undefined || node.data.instructions.trim() === ''
        ? null : [t('editor.fields.instructions'), <span key="instructions" className="whitespace-pre-wrap">{node.data.instructions}</span>],
    ]} />
  )
}

/** "In this flow": the step's fields, edited while building (StepForm and the kind's extras), else as text. */
export function InThisFlow({ props, rows, extras }: Readonly<{
  props: KindViewProps
  /** The kind's own rows as text (view, run). */
  rows?: ReadonlyArray<readonly [string, ReactNode] | null>
  /** The kind's own controls after the step's fields (build). */
  extras?: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const { node, definition, mode, issues, onChange } = props
  return (
    <section className="space-y-2" aria-label={t('inspector.inFlow')}>
      <SectionHeading>{t('inspector.inFlow')}</SectionHeading>
      {mode === 'build' ? (
        <>
          <StepForm node={node} definition={definition} issues={issues} readOnly={false} onChange={onChange} showType={false} />
          {extras}
        </>
      ) : <StepFacts node={node} rows={rows} />}
    </section>
  )
}

/** A step's arrows in words ("→ Commit the fix · GO"); an arrow that cannot carry a condition always runs. */
export function ArrowsText({ node, definition, run }: Readonly<{ node: WorkflowNode; definition: WorkflowDefinition; run?: InspectorRun }>) {
  const { t } = useTranslation('agents')
  const out = definition.edges.filter((edge) => edge.source === node.id)
  if (out.length === 0) return <p className="text-[12px] text-muted">{t('editor.noArrowsOut')}</p>
  const title = (id: string) => definition.nodes.find((each) => each.id === id)?.data.title ?? id
  return (
    <ul className="space-y-1 text-[13px]">
      {out.map((edge) => {
        const reached = run?.states.get(edge.target)
        const taken = reached !== undefined && reached.status !== 'idle' && reached.status !== 'skipped'
        return (
          <li key={edge.id} className="flex flex-wrap items-center gap-2">
            <span className="text-text">→ {title(edge.target)}</span>
            {edge.label !== undefined && <span className="badge badge-muted">{t(`edgeLabels.${edge.label}`)}</span>}
            {run !== undefined && <span className="text-[12px] text-muted">{t(taken ? 'inspector.edge.taken' : 'inspector.edge.notTaken')}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** A step's arrows: edited from it while building (its conditions, Add an arrow), in words otherwise. */
export function Arrows({ props }: Readonly<{ props: KindViewProps }>) {
  const { node, definition, mode, run, onChange } = props
  if (mode === 'build') return <StepArrows definition={definition} node={node} readOnly={false} onChange={onChange} />
  return <ArrowsText node={node} definition={definition} run={run} />
}

/** A step's assertions where `place` checks them: edited while building, with what the board recorded in a run. */
export function StepAssertions({ props, place }: Readonly<{ props: KindViewProps; place: string }>) {
  const { node, definition, mode, run, onChange } = props
  return (
    <AssertionsField place={place} value={node.data.params?.assert} mode={mode}
      results={run?.assertions?.filter((result) => result.step === node.id)}
      onChange={(next) => onChange(withAssertions(definition, node.id, next))} />
  )
}

/** What the run workspace draws for a step (its agents, a gate's checks), or that it has not run yet. */
export function RunSlot({ content, empty }: Readonly<{ content: ReactNode; empty: string }>) {
  return content === undefined || content === null ? <p className="text-sm text-muted">{empty}</p> : <>{content}</>
}
