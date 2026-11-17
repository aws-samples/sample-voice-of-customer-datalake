/**
 * @fileoverview The Gate inspector (7.52.00 C2; docs/ux part 5 §5.4 "Gate"): Setup, Packs, Assertions and Arrows; in a
 * run Checks, Reviewers and Setup (the run workspace's read of the gate runner's gate: `checksOf`).
 * - **In this flow:** its packs (Auto-detect or chosen), rounds, final-go model (StepForm), its REVIEWERS (an editor:
 *   each blocks or is advisory, a new one needs a focus, at least one blocks), who runs it (`runner`, `final_go`: the
 *   roles at their latest skill unless the step names a card), and its arrows: GO → …, NO-GO → ….
 * - **Packs** (read only): GatePacks.tsx.
 *
 * @module components/WorkflowEditor/inspector/GateInspector
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../../Tooltip/Tooltip'
import { gatePacksText } from '../nodes/nodeText'
import { Facts } from './InspectorShell'
import { GatePacks } from './GatePacks'
import { Arrows, InThisFlow, RunSlot, StepAssertions } from './inspectorParts'
import { setParams } from './stepEdits'
import { gateTabs } from './inspectorTabs'
import { DEFAULT_ADVISORY, REVIEWER_NAME, reviewersOf, stored } from './gateReviewers'
import type { GateTab } from './inspectorTabs'
import type { Reviewer } from './gateReviewers'
import { useFlowUsage, useGatePacks } from './useFlowSetup'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { WorkflowDefinition, WorkflowNode } from '../../../api/workflowsApi'
import type { KindViewProps } from './inspectorParts'

function AddReviewer({ taken, onAdd }: Readonly<{ taken: ReadonlySet<string>; onAdd: (reviewer: Reviewer) => void }>) {
  const { t } = useTranslation('agents')
  const [name, setName] = useState('')
  const [focus, setFocus] = useState('')
  const valid = REVIEWER_NAME.test(name) && !taken.has(name) && (name in DEFAULT_ADVISORY || focus.trim() !== '')
  return (
    <div role="group" aria-label={t('inspector.gate.addReviewer')} className="flex flex-wrap items-center gap-2">
      <input aria-label={t('inspector.gate.reviewerName')} className="input w-32" maxLength={40} value={name}
        onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
      <input aria-label={t('inspector.gate.reviewerFocus')} className="input min-w-0 flex-1" maxLength={200} value={focus}
        onChange={(e) => setFocus(e.target.value)} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={!valid}
        onClick={() => { onAdd({ name, advisory: false, ...(focus.trim() === '' ? {} : { focus: focus.trim() }) }); setName(''); setFocus('') }}>
        <Plus size={14} aria-hidden="true" /> {t('inspector.gate.addReviewer')}
      </button>
    </div>
  )
}

/** The reviewers editor (build): blocks or advisory, removed (never the last one that blocks), one added. */
function ReviewersEditor({ node, definition, onChange }: Readonly<{
  node: WorkflowNode; definition: WorkflowDefinition; onChange: (definition: WorkflowDefinition) => void
}>) {
  const { t } = useTranslation('agents')
  const reviewers = reviewersOf(node.data.params ?? {})
  const write = (next: readonly Reviewer[]) =>
    onChange(setParams(definition, node.id, (current) => ({ ...current, reviewers: next.map(stored) })))
  const blocking = reviewers.filter((reviewer) => !reviewer.advisory).length
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-medium text-muted">{t('inspector.gate.reviewers')}</legend>
      <ul className="space-y-1">
        {reviewers.map((reviewer, index) => (
          <li key={reviewer.name} className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-text">{reviewer.name}</span>
            <select aria-label={t('inspector.gate.reviewerRole', { name: reviewer.name })} className="select select-sm"
              value={reviewer.advisory ? 'advisory' : 'blocks'}
              disabled={!reviewer.advisory && blocking === 1}
              onChange={(e) => write(reviewers.map((each, at) => (at === index ? { ...each, advisory: e.target.value === 'advisory' } : each)))}>
              <option value="blocks">{t('inspector.gate.blocks')}</option>
              <option value="advisory">{t('inspector.gate.advisory')}</option>
            </select>
            <Tooltip kind="label" content={t('inspector.gate.removeReviewer', { name: reviewer.name })}>
              <button type="button" className="icon-btn" aria-label={t('inspector.gate.removeReviewer', { name: reviewer.name })}
                disabled={reviewers.length === 1 || (!reviewer.advisory && blocking === 1)}
                onClick={() => write(reviewers.filter((_each, at) => at !== index))}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      <AddReviewer taken={new Set(reviewers.map((reviewer) => reviewer.name))} onAdd={(added) => write([...reviewers, added])} />
    </fieldset>
  )
}

/** Who runs the gate: its runner and its final go (the step's, else the defaults the gates read names). */
function useRunners(params: Readonly<Record<string, unknown>>): { runner: string; finalGo: string } {
  const gates = useGatePacks(null)
  const defaults = gates.data?.defaults ?? { runner: 'gate-runner@latest', final_go: 'final-go@latest' }
  return {
    runner: typeof params.runner === 'string' ? params.runner : defaults.runner,
    finalGo: typeof params.final_go === 'string' ? params.final_go : defaults.final_go,
  }
}

/** The gate's arrows in words: "GO → Commit the fix", "NO-GO → A person decides". */
function arrowsLine(t: TFunction<'agents'>, node: WorkflowNode, definition: WorkflowDefinition): string {
  const title = (id: string) => definition.nodes.find((each) => each.id === id)?.data.title ?? id
  return definition.edges.filter((edge) => edge.source === node.id && edge.label !== undefined)
    .map((edge) => `${t(edge.label === 'pass' ? 'canvas.gate.go' : 'canvas.gate.noGo')} → ${title(edge.target)}`).join(' · ')
}

function GateSetup({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { node, definition, onChange } = props
  const params = node.data.params ?? {}
  const { runner, finalGo } = useRunners(params)
  const reviewers = reviewersOf(params)
  const who: ReadonlyArray<readonly [string, ReactNode] | null> = [
    [t('inspector.gate.runsIt'), runner],
    [t('inspector.gate.finalGo'), typeof params.final_go_model === 'string' ? `${finalGo} · ${params.final_go_model}` : finalGo],
    [t('inspector.gate.arrows'), arrowsLine(t, node, definition) || t('editor.noArrowsOut')],
  ]
  return (
    <>
      <InThisFlow props={props}
        rows={[
          [t('inspector.gate.packs'), gatePacksText(t, params)],
          [t('inspector.gate.rounds'), String(typeof params.max_rounds === 'number' ? params.max_rounds : 3)],
          [t('inspector.gate.reviewers'), reviewers.map((reviewer) => `${reviewer.name} (${t(reviewer.advisory ? 'inspector.gate.advisory' : 'inspector.gate.blocks')})`).join(', ')],
        ]}
        extras={<ReviewersEditor node={node} definition={definition} onChange={onChange} />} />
      <Facts rows={who} />
    </>
  )
}

/** Packs: the packs the gate runs, read only (with Auto-detect, the one each automation's language picks). */
function GatePacksTab({ props }: Readonly<{ props: KindViewProps }>) {
  const usage = useFlowUsage(props.workflowId)
  return <GatePacks packs={props.node.data.params?.packs} automations={usage.usedBy.automations} connection={props.connection} />
}

/** A run's reviewers: each blocks or is advisory. */
function ReviewersFacts({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const rows = reviewersOf(props.node.data.params ?? {})
    .map((reviewer) => [reviewer.name, t(reviewer.advisory ? 'inspector.gate.advisory' : 'inspector.gate.blocks')] as const)
  return <Facts rows={rows} />
}

export function GateInspector({ props, tab: asked }: Readonly<{ props: KindViewProps; tab: string }>) {
  const { t } = useTranslation('agents')
  const tab: GateTab = gateTabs(props.mode).find((id) => id === asked) ?? 'setup'
  switch (tab) {
    case 'checks':
      return <RunSlot content={props.run?.checksOf?.(props.node.id)} empty={t('inspector.empty.gateNotRun')} />
    case 'reviewers':
      return <ReviewersFacts props={props} />
    case 'packs':
      return <GatePacksTab props={props} />
    case 'assertions':
      return <StepAssertions props={props} place="quality_gate" />
    case 'arrows':
      return <Arrows props={props} />
    case 'setup':
      return <GateSetup props={props} />
  }
}
