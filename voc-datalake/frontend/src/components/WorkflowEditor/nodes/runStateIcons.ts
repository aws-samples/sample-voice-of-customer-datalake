/**
 * @fileoverview The run states' icons and tones: a node's corner badge on the canvas (NodeStateBadge) and a step's
 * icon on the run's timeline (pages/Agents/RunWorkspace/RunTimeline, where `done` is its `ok`). Planned has none
 * here: on the canvas its dashed outline and words say it.
 *
 * @module components/WorkflowEditor/nodes/runStateIcons
 */
import { CircleCheck, CirclePause, CircleX, Hand, Loader2, SkipForward, Square } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** A run state's icon and its tone. */
export interface RunStateIcon {
  readonly icon: LucideIcon
  readonly tone: string
}

type IconedState = 'running' | 'done' | 'failed' | 'waiting' | 'paused' | 'stopped' | 'skipped'

export const RUN_STATE_ICONS: Readonly<Record<IconedState, RunStateIcon>> = {
  running: { icon: Loader2, tone: 'animate-spin text-accent-text' },
  done: { icon: CircleCheck, tone: 'text-ok' },
  failed: { icon: CircleX, tone: 'text-danger' },
  waiting: { icon: Hand, tone: 'text-warn' },
  paused: { icon: CirclePause, tone: 'text-warn' },
  stopped: { icon: Square, tone: 'fill-current text-muted' },
  skipped: { icon: SkipForward, tone: 'text-muted' },
}
