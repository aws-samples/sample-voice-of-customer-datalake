/**
 * @fileoverview The Edge inspector (7.52.00 C2; docs/ux part 5 §5.4): an arrow's source and target, and its condition,
 * edited while building (the editor's EdgeForm), in words otherwise ("Always: this step reports no verdict" where
 * the source reports none); in a run, Taken or Not taken, from its target's state.
 *
 * @module components/WorkflowEditor/inspector/EdgeInspector
 */
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EdgeForm } from '../ArrowSettings'
import { edgeLabelsFor } from '../model'
import { Facts, InspectorShell } from './InspectorShell'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { FlowMode } from '../nodes/nodeData'
import type { InspectorRun } from './inspectorParts'

export function EdgeInspector({ definition, edgeId, mode, run, onChange, onClose, focusHeading }: Readonly<{
  definition: WorkflowDefinition; edgeId: string; mode: FlowMode; run?: InspectorRun
  onChange: (definition: WorkflowDefinition) => void; onClose?: () => void; focusHeading?: boolean
}>) {
  const { t } = useTranslation('agents')
  const edge = definition.edges.find((each) => each.id === edgeId)
  if (edge === undefined) return null
  const title = (id: string) => definition.nodes.find((each) => each.id === id)?.data.title ?? id
  const source = definition.nodes.find((each) => each.id === edge.source)
  const verdicts = edgeLabelsFor(source?.type)
  const none = verdicts.length === 0 ? 'inspector.edge.always' : 'editor.fields.labelNone'
  const condition = edge.label === undefined ? t(none) : t(`edgeLabels.${edge.label}`)
  const reached = run?.states.get(edge.target)
  const taken = reached !== undefined && reached.status !== 'idle' && reached.status !== 'skipped'
  const tile = (
    <span aria-hidden="true" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted">
      <ArrowRight size={14} />
    </span>
  )
  return (
    <InspectorShell tile={tile} title={t('inspector.edge.title')} kindLine={`${title(edge.source)} → ${title(edge.target)}`}
      mode={mode} runRevision={run?.revision} onClose={onClose} focusHeading={focusHeading}>
      {mode === 'build' ? <EdgeForm definition={definition} edgeId={edgeId} readOnly={false} onChange={onChange} /> : (
        <Facts rows={[
          [t('inspector.edge.from'), title(edge.source)],
          [t('inspector.edge.to'), title(edge.target)],
          [t('inspector.edge.condition'), condition],
          run === undefined ? null : [t('inspector.edge.inRun'), t(taken ? 'inspector.edge.taken' : 'inspector.edge.notTaken')],
        ]} />
      )}
    </InspectorShell>
  )
}
