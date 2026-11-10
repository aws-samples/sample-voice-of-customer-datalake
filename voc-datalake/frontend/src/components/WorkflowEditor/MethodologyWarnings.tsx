/**
 * @fileoverview The workflow's methodology gaps: a writing step with no evidence, personas or PR/FAQ
 * before it (`POST /workflows/validate` → `warnings`, lambda/shared/workflow_methodology.py).
 *
 * Advice, never an error: the workflow still saves and runs (it may work on a project that already
 * holds those artefacts). Each line names the step it is about; a code this client does not know
 * shows the server's own sentence. Renders nothing when there is no warning.
 * @module components/WorkflowEditor/MethodologyWarnings
 */
import { Compass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { WorkflowDefinition, WorkflowMethodologyWarning } from '../../api/workflowsApi'

/** The sentence for one warning code (each key literal, so the extractor sees it). */
function warningText(t: TFunction<'agents'>, warning: WorkflowMethodologyWarning): string {
  switch (warning.code) {
    case 'no_upstream_evidence': return t('editor.methodology.noEvidence')
    case 'no_upstream_personas': return t('editor.methodology.noPersonas')
    case 'no_upstream_prfaq': return t('editor.methodology.noPrfaq')
    case 'no_upstream_document': return t('editor.methodology.noDocument')
    default: return warning.message
  }
}

function stepTitle(definition: WorkflowDefinition, nodeId: string | undefined): string {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId)
  return node?.data.title ?? nodeId ?? ''
}

export default function MethodologyWarnings({ warnings, definition }: Readonly<{
  warnings: readonly WorkflowMethodologyWarning[]
  definition: WorkflowDefinition
}>) {
  const { t } = useTranslation('agents')
  if (warnings.length === 0) return null
  return (
    <section data-testid="workflow-methodology-warnings" className="rounded-md border p-3 text-sm">
      <h3 className="flex items-center gap-1.5 font-medium">
        <Compass size={14} aria-hidden="true" />
        {t('editor.methodology.title')}
      </h3>
      <p className="text-xs text-muted">{t('editor.methodology.hint')}</p>
      <ul className="mt-2 space-y-1">
        {warnings.map((warning) => (
          <li key={`${warning.node_id ?? ''}:${warning.code}`}>
            <span className="font-medium">{stepTitle(definition, warning.node_id)}</span>
            {': '}
            {warningText(t, warning)}
          </li>
        ))}
      </ul>
    </section>
  )
}
