/**
 * @fileoverview Several sessions side by side (7.51.00): a grid of 1, 2 or 4 panes (agentGridModel.ts, adapted from
 * KiroCrew's useSessionGrid and SessionGridView), each holding one agent's session or a picker; a pane is closed
 * (its siblings take its room) and the divider between two panes moves, by pointer or by the arrow keys. The pane
 * whose agent the address names is outlined, and the inspector follows it; a press in a pane moves to its agent.
 *
 * @module pages/Agents/RunWorkspace/AgentGrid
 */
import { useId } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SessionThread } from './SessionThread'
import { useSessionName } from './useSessionLayout'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { GridLeaf, GridNode, GridSplit } from './agentGridModel'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

/** How far one arrow key moves a divider. */
const KEY_STEP = 0.05
const KEY_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -KEY_STEP, ArrowUp: -KEY_STEP, ArrowRight: KEY_STEP, ArrowDown: KEY_STEP }

interface Props {
  runId: string
  grid: GridNode
  agents: readonly EngineeringAgent[]
  orchestrator: string | null
  current: string | null
  canAct: boolean
  onFocus: (agent: string) => void
  onFill: (paneId: string, agent: string | null) => void
  onClosePane: (paneId: string) => void
  onResize: (splitId: string, index: number, delta: number) => void
}

function Divider({ split, index, onResize }: Readonly<{ split: GridSplit; index: number; onResize: Props['onResize'] }>) {
  const { t } = useTranslation('agents')
  const across = split.dir === 'col'
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[event.key]
    if (step === undefined) return
    event.preventDefault()
    onResize(split.id, index, step)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect()
    if (event.buttons !== 1 || box === undefined) return
    const extent = across ? box.width : box.height
    if (extent > 0) onResize(split.id, index, (across ? event.movementX : event.movementY) / extent)
  }
  return (
    <div role="separator" tabIndex={0} aria-orientation={across ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round((split.sizes[index] ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}
      aria-label={t('runWorkspace.sessions.divider')} onKeyDown={onKeyDown}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={onPointerMove}
      className={clsx('shrink-0 bg-border hover:bg-accent focus-visible:bg-accent', across ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize')} />
  )
}

function Pane({ pane, ...props }: Readonly<Omit<Props, 'grid'> & { pane: GridLeaf }>) {
  const { t } = useTranslation('agents')
  const pickerId = useId()
  const nameOf = useSessionName(props.orchestrator)
  const agent = props.agents.find((candidate) => candidate.agent === pane.agent)
  const tools = (
    <>
      <label htmlFor={pickerId} className="sr-only">{t('runWorkspace.sessions.paneAgent')}</label>
      <select id={pickerId} className="select w-auto text-[12px]" value={pane.agent ?? ''}
        onChange={(event) => props.onFill(pane.id, event.target.value === '' ? null : event.target.value)}>
        <option value="">{t('runWorkspace.sessions.choose')}</option>
        {props.agents.map((option) => <option key={option.agent} value={option.agent}>{nameOf(option.agent)}</option>)}
      </select>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => props.onClosePane(pane.id)}
        aria-label={t('runWorkspace.sessions.closePane')}>
        <X size={14} aria-hidden="true" />
      </button>
    </>
  )
  return (
    <div className={clsx('flex h-full min-h-0 min-w-0 flex-col rounded-md border',
      pane.agent !== null && pane.agent === props.current ? 'border-accent' : 'border-border')}
    onPointerDown={() => { if (agent !== undefined && agent.agent !== props.current) props.onFocus(agent.agent) }}>
      {agent === undefined
        ? <div className="flex flex-wrap items-center gap-2 p-2 text-sm text-muted">{t('runWorkspace.sessions.emptyPane')}<span className="ml-auto flex gap-1">{tools}</span></div>
        : <SessionThread runId={props.runId} agent={agent} orchestrator={agent.agent === props.orchestrator} canAct={props.canAct} tools={tools} />}
    </div>
  )
}

function GridView({ node, ...props }: Readonly<Omit<Props, 'grid'> & { node: GridNode }>) {
  if (node.type === 'leaf') return <Pane pane={node} {...props} />
  return (
    <div className={clsx('flex h-full min-h-0 min-w-0 gap-1', node.dir === 'col' ? 'flex-row' : 'flex-col')}>
      {node.children.map((child, index) => (
        <div key={child.id} className="contents">
          {index > 0 && <Divider split={node} index={index - 1} onResize={props.onResize} />}
          <div className="min-h-0 min-w-0" style={{ flexBasis: 0, flexGrow: node.sizes[index] ?? 1 }}>
            <GridView node={child} {...props} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function AgentGrid({ grid, ...props }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  return (
    <div className="h-full min-h-0 p-1" role="group" aria-label={t('runWorkspace.sessions.grid')}>
      <GridView node={grid} {...props} />
    </div>
  )
}
