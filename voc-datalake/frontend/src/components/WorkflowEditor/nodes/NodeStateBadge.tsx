/**
 * @fileoverview A node's corner badge (7.52.00 C2; docs/ux part 5 §5.3 "Run-state overlay"): a 20 px circle at the
 * shape's top-right carrying the run state as an icon and its words (running spins; a step whose turn it is with
 * nobody at work on it does not), or, while building, an issue's warning. The tile never changes with state; the
 * outline (`data-state`) and this badge carry it, so colour is never the only cue.
 *
 * @module components/WorkflowEditor/nodes/NodeStateBadge
 */
import { AlertTriangle, CircleDot, MapPin, ShieldCheck, ShieldX } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { RUN_STATE_ICONS } from './runStateIcons'
import type { RunStateIcon } from './runStateIcons'
import type { StepState } from '../runState'

/** Each run state's badge (RUN_STATE_ICONS). */
const RUN_BADGES: Readonly<Partial<Record<StepState['status'], RunStateIcon>>> = RUN_STATE_ICONS

export function NodeStateBadge({ run, invalid }: Readonly<{ run: StepState | undefined; invalid: boolean }>) {
  const { t } = useTranslation('agents')
  if (run === undefined) {
    if (!invalid) return null
    return (
      <span className="voc-node-badge">
        <AlertTriangle size={12} className="text-danger" aria-label={t('canvas.state.invalid')} />
      </span>
    )
  }
  if (run.status === 'running' && run.spin === false) {
    return <span className="voc-node-badge"><CircleDot size={12} className="text-accent-text" aria-label={t('run.stepStatus.ready')} /></span>
  }
  const badge = RUN_BADGES[run.status]
  if (badge === undefined) return null
  const { icon: Icon, tone } = badge
  return (
    <span className="voc-node-badge">
      <Icon size={12} className={clsx('shrink-0', tone)} aria-label={t(`run.stepStatus.${run.status}`)} />
    </span>
  )
}

/** "Stopped here"'s tone: the state it stopped in (danger failed, warn at a person or held, muted stopped). */
const STOPPED_HERE: Readonly<Partial<Record<StepState['status'], string>>> = {
  failed: 'badge-danger', waiting: 'badge-warn', paused: 'badge-warn',
}

/** "You are here" on the step the run is on, or "Stopped here" where it stopped: a tag above the node, not a ring. */
export function HereTag({ run }: Readonly<{ run: StepState | undefined }>) {
  const { t } = useTranslation('agents')
  if (run?.here === undefined) return null
  if (run.here === 'on') {
    return <span className="voc-node-here badge badge-accent"><MapPin size={11} aria-hidden="true" /> {t('run.here')}</span>
  }
  const tone = STOPPED_HERE[run.status]
  return (
    <span className={clsx('voc-node-here badge', tone ?? 'badge-muted')}>
      <MapPin size={11} aria-hidden="true" />{' '}
      {tone === undefined ? t('run.stoppedHere') : t('run.stoppedHereAs', { state: t(`run.stepStatus.${run.status}`) })}
    </span>
  )
}

/** A gate's verdict in a run: GO or NO-GO (Agreed or Not agreed on a persona review are the arrows' words). */
export function VerdictBadge({ run }: Readonly<{ run: StepState | undefined }>) {
  const { t } = useTranslation('agents')
  if (run?.gate === 'pass') return <span className="badge badge-ok"><ShieldCheck size={11} aria-hidden="true" /> {t('canvas.gate.go')}</span>
  if (run?.gate === 'fail') return <span className="badge badge-danger"><ShieldX size={11} aria-hidden="true" /> {t('canvas.gate.noGo')}</span>
  return null
}
