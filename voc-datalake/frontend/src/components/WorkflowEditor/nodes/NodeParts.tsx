/**
 * @fileoverview The parts every node kind is drawn from (7.52.00 C2; docs/ux part 5 §5.3): the frame (the shape, its
 * state outline, selection fill and corner badge, the "here" tag, the handles), the icon tile toned by who acts, the
 * title and second line, and the chips (`badge-muted`, at most three, then "+N"). The kind renderers
 * (`AgentNode`, `GateNode`, …) only choose a shape and say what goes in it.
 *
 * Handles: one target on top, one source at the bottom; a gate's GO and NO-GO (a persona review's Agreed and Not
 * agreed) are two source handles at a quarter and three quarters, each with its word under it while building (owner
 * decision N-D4). In view and run nothing connects: the handles are only where the arrows meet.
 *
 * @module components/WorkflowEditor/nodes/NodeParts
 */
import { Handle, Position } from '@xyflow/react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { HereTag, NodeStateBadge } from './NodeStateBadge'
import { HELD_STATES, TILE_CLASS, hasSource, hasTarget, kindSize, tileTone, verdictHandles } from './nodeKinds'
import { glyphNameOf } from './nodeGlyphs'
import { GlyphIcon } from './GlyphIcon'
import { foldChips } from './nodeText'
import { nodeDescriptionId, useFlowLookups } from './nodeData'
import type { ReactNode } from 'react'
import type { WorkflowNode } from '../../../api/workflowsApi'
import type { FlowMode, StepNodeData } from './nodeData'
import type { NodeKind } from './nodeKinds'
import type { NodeChip } from './nodeText'

/** The source and target handles of a step, as its kind has them. */
function StepHandles({ step, kind, mode }: Readonly<{ step: WorkflowNode; kind: NodeKind; mode: FlowMode }>) {
  const { t } = useTranslation('agents')
  const building = mode === 'build'
  const hidden = building ? undefined : 'voc-handle-hidden'
  const verdicts = verdictHandles(step.type)
  return (
    <>
      {hasTarget(kind) && <Handle type="target" position={Position.Top} isConnectable={building} className={hidden} />}
      {hasSource(kind) && verdicts.length === 0 && (
        <Handle type="source" position={Position.Bottom} isConnectable={building} className={hidden} />
      )}
      {hasSource(kind) && verdicts.map((verdict) => (
        <Handle key={verdict.label} id={verdict.label} type="source" position={Position.Bottom} isConnectable={building}
          className={clsx(`voc-handle-${verdict.side}`, hidden)} aria-label={t('canvas.handles.arrow', { word: t(`canvas.handles.${verdict.word}`) })} />
      ))}
      {building && verdicts.map((verdict) => (
        <span key={verdict.label} className={`voc-handle-word voc-handle-word-${verdict.side}`} aria-hidden="true">
          {t(`canvas.handles.${verdict.word}`)}
        </span>
      ))}
    </>
  )
}

/**
 * The shape of one step: its kind's shape class, its state's outline (`data-state`, held by the state so a selection
 * shows by its fill), the corner badge, the tag above it, its handles and its description for assistive tech (the
 * role, the chips, a failure's reason: the node's `aria-describedby`).
 */
export function NodeFrame({ id, data, selected, shape, description, children }: Readonly<{
  id: string; data: StepNodeData; selected: boolean
  /** The kind's shape class (`voc-node-agent`, `voc-node-gate`, `voc-node-pill`…). */
  shape: string
  description: string
  children: ReactNode
}>) {
  const { mode, descPrefix, handles } = useFlowLookups()
  const { step, kind, issues, run } = data
  const size = kindSize(kind)
  const held = run !== undefined && HELD_STATES.has(run.status)
  return (
    <div className="voc-node-shell" style={{ width: size.width, minHeight: size.height }} data-testid={`step-${step.id}`}
      data-kind={kind} data-state={run?.status}>
      <HereTag run={run} />
      <div data-state={run?.status} data-selected={selected} data-held={held} className={clsx('voc-node', shape)}
        style={{ minHeight: size.height }}>
        {children}
      </div>
      <NodeStateBadge run={run} invalid={issues.length > 0} />
      <span id={nodeDescriptionId(descPrefix, id)} className="sr-only">{description}</span>
      {handles && <StepHandles step={step} kind={kind} mode={mode} />}
    </div>
  )
}

/** The icon tile, toned by who acts (`aim` a model, `warn` a person, neutral the platform); `round`: an avatar. */
export function NodeTile({ step, kind, size = 28, round = false, glyph }: Readonly<{
  step: Pick<WorkflowNode, 'type' | 'data'>; kind: NodeKind; size?: number; round?: boolean
  /** In place of the kind's glyph (a gate's verdict in a run): its name (`GLYPHS`) and tone. */
  glyph?: { name: string; tone: string }
}>) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size }}
      className={clsx('inline-flex shrink-0 items-center justify-center', round ? 'rounded-full' : 'rounded-md', TILE_CLASS[tileTone(kind)])}>
      <GlyphIcon name={glyph?.name ?? glyphNameOf(step)} size={Math.round(size / 2)} className={glyph?.tone} />
    </span>
  )
}

/** The title (one line) and the second line; a step not reached in a run reads muted. */
export function NodeLines({ title, line, quiet = false }: Readonly<{ title: string; line?: string; quiet?: boolean }>) {
  return (
    <span className="min-w-0 flex-1">
      <span className={clsx('block truncate text-[13px] font-semibold leading-snug', quiet ? 'text-muted' : 'text-text-strong')}>{title}</span>
      {line !== undefined && line !== '' && <span className="block truncate text-[12px] leading-snug text-text">{line}</span>}
    </span>
  )
}

/** At most three chips, then "+N" (R15: descriptive chips are `badge-muted`; "Update available" is `badge-info`). */
export function NodeChips({ chips }: Readonly<{ chips: readonly NodeChip[] }>) {
  const { t } = useTranslation('agents')
  const { shown, more } = foldChips(chips)
  if (shown.length === 0) return null
  return (
    <span className="mt-1 flex min-w-0 flex-wrap gap-1">
      {shown.map((chip) => (
        <span key={chip.text} className={clsx('badge', chip.tone === 'info' ? 'badge-info' : 'badge-muted')}>{chip.text}</span>
      ))}
      {more > 0 && <span className="badge badge-muted">{t('canvas.chips.more', { n: more })}</span>}
    </span>
  )
}

/** The first inline issue of a step (build), in words, with how many more there are. */
export function NodeIssue({ issues }: Readonly<{ issues: readonly string[] }>) {
  if (issues.length === 0) return null
  const more = issues.length > 1 ? ` (+${issues.length - 1})` : ''
  return <span className="mt-1 block line-clamp-2 text-[12px] text-danger">{issues[0]}{more}</span>
}
