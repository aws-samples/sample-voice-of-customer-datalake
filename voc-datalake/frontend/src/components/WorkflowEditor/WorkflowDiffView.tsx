/**
 * @fileoverview What one workflow definition adds, removes and changes relative
 * to another, as lists of step and arrow names (moves alone collapsed). Shared
 * by the `update_workflow` approval card and the editor's revision History.
 *
 * @module components/WorkflowEditor/WorkflowDiffView
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { movedOnly } from './diff'
import type { WorkflowDiff } from './diff'
import type { WorkflowDefinition } from '../../api/workflowsApi'

type Lookup = (id: string) => string

function titles(...definitions: (WorkflowDefinition | null)[]): { node: Lookup; edge: Lookup } {
  const nodes = new Map<string, string>()
  const edges = new Map<string, string>()
  for (const d of definitions) {
    for (const n of d?.nodes ?? []) nodes.set(n.id, n.data.title)
  }
  const node: Lookup = (id) => nodes.get(id) ?? id
  for (const d of definitions) {
    for (const e of d?.edges ?? []) {
      const label = e.label === undefined ? '' : ` (${e.label})`
      edges.set(e.id, `${node(e.source)} → ${node(e.target)}${label}`)
    }
  }
  return { node, edge: (id) => edges.get(id) ?? id }
}

const TONE_FILL = { ok: 'bg-ok-subtle', danger: 'bg-danger-subtle', warn: 'bg-warn-subtle' } as const

function Group({ label, tone, items }: Readonly<{ label: string; tone: 'ok' | 'danger' | 'warn'; items: string[] }>) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[12px] font-medium text-muted">{label} <span className="font-mono">({items.length})</span></p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((text) => (
          <li key={text} className={`rounded-sm px-1.5 py-0.5 text-sm text-text-strong ${TONE_FILL[tone]}`}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

export function WorkflowDiffView({ diff, before, after }: Readonly<{ diff: WorkflowDiff; before: WorkflowDefinition | null; after: WorkflowDefinition }>) {
  const { t } = useTranslation('assistantTools')
  const [showMoves, setShowMoves] = useState(false)
  const name = titles(before, after)
  const moved = new Set(movedOnly(diff))
  const changedNodes = diff.nodes.changed.filter((c) => showMoves || !moved.has(c.id))
  if (diff.unchanged) return <p className="text-[12px] text-muted">{t('preview.workflow.unchanged')}</p>
  return (
    <div className="space-y-2">
      {diff.metaChanged.length > 0 && (
        <p className="text-sm text-text">{t('preview.workflow.meta', { fields: diff.metaChanged.join(', ') })}: <span className="text-text-strong">{after.name}</span></p>
      )}
      <Group label={t('preview.workflow.addedSteps')} tone="ok" items={diff.nodes.added.map(name.node)} />
      <Group label={t('preview.workflow.removedSteps')} tone="danger" items={diff.nodes.removed.map(name.node)} />
      <Group label={t('preview.workflow.changedSteps')} tone="warn"
        items={changedNodes.map((c) => `${name.node(c.id)} · ${c.fields.join(', ')}`)} />
      {moved.size > 0 && (
        <button type="button" className="text-[12px] font-medium link" onClick={() => setShowMoves((v) => !v)}>
          {showMoves ? t('preview.workflow.hideMoves') : t('preview.workflow.showMoves', { n: moved.size })}
        </button>
      )}
      <Group label={t('preview.workflow.addedArrows')} tone="ok" items={diff.edges.added.map(name.edge)} />
      <Group label={t('preview.workflow.removedArrows')} tone="danger" items={diff.edges.removed.map(name.edge)} />
      <Group label={t('preview.workflow.changedArrows')} tone="warn"
        items={diff.edges.changed.map((c) => `${name.edge(c.id)} · ${c.fields.join(', ')}`)} />
      {diff.loopsChanged && <p className="text-[12px] text-warn">{t('preview.workflow.loopsChanged', { n: after.loops.length })}</p>}
    </div>
  )
}
