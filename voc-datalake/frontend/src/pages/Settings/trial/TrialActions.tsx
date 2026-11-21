/**
 * @fileoverview A trial workspace's row in the platform console (7.71.00; docs/multi-workspace.md "Trial workspaces"):
 * its state (running until its end, paused since, or converted), and, until it is converted, Extend (14, 30 or 60 more
 * days: a paused trial's plugins and forms are turned back on) and Convert (a regular workspace from then on, after a
 * confirmation). Neither deletes anything, and nor does the trial's end: it only pauses.
 *
 * @module pages/Settings/trial/TrialActions
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import {
  DEFAULT_TRIAL_DAYS, platformWorkspacesApi, platformWorkspacesKey, toTrialDays, TRIAL_DAYS,
} from '../../../api/platformWorkspacesApi'
import type { PlatformWorkspace, TrialDays } from '../../../api/platformWorkspacesApi'
import type { TrialSummary } from '../../../api/workspacesApi'
import { formatDate } from '../../../utils/dateUtils'
import RefusalAlert from '../../../workspace/RefusalAlert'
import { isTrialPaused } from '../../../workspace/currentTrial'
import { TRIAL_REFUSALS } from '../../../workspace/workspaceRefusals'

/** The trial's state as a badge: its end, its pause, or its conversion. */
export function TrialBadge({ trial }: Readonly<{ trial: TrialSummary }>) {
  const { t, i18n } = useTranslation()
  if (trial.converted_at !== null) return <span className="badge badge-muted">{t('workspaces.trial.badge.converted')}</span>
  if (isTrialPaused(trial)) {
    return <span className="badge badge-warn">{t('workspaces.trial.badge.paused', { date: formatDate(trial.paused_at, i18n.language) })}</span>
  }
  return <span className="badge badge-accent">{t('workspaces.trial.badge.running', { date: formatDate(trial.expires_at, i18n.language) })}</span>
}

/** Extend and Convert for a trial that is not converted; nothing otherwise. */
export default function TrialActions({ workspace }: Readonly<{ workspace: PlatformWorkspace }>) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const extendId = useId()
  const [days, setDays] = useState<TrialDays>(DEFAULT_TRIAL_DAYS)
  const [confirming, setConfirming] = useState(false)
  const settled = () => queryClient.invalidateQueries({ queryKey: platformWorkspacesKey() })
  const extend = useMutation({ mutationFn: (more: TrialDays) => platformWorkspacesApi.extendTrial(workspace.id, more), onSettled: settled })
  const convert = useMutation({ mutationFn: () => platformWorkspacesApi.convertTrial(workspace.id), onSettled: settled })
  const trial = workspace.trial
  if (trial?.converted_at !== null) return null
  const busy = extend.isPending || convert.isPending
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={extendId} className="sr-only">{t('workspaces.trial.extendBy', { name: workspace.name })}</label>
        <select id={extendId} className="input w-auto py-1 text-xs" value={days} disabled={busy}
          onChange={(event) => setDays(toTrialDays(event.target.value))}>
          {TRIAL_DAYS.map((option) => <option key={option} value={option}>{t('workspaces.trial.daysOption', { days: option })}</option>)}
        </select>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => extend.mutate(days)}>
          {t('workspaces.trial.extend')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
          aria-label={t('workspaces.trial.convertWho', { name: workspace.name })} onClick={() => setConfirming(true)}>
          {t('workspaces.trial.convert')}
        </button>
      </div>
      <RefusalAlert error={extend.error ?? convert.error} refusals={TRIAL_REFUSALS} />
      <ConfirmModal isOpen={confirming} variant="warning" title={t('workspaces.trial.convertTitle', { name: workspace.name })}
        message={isTrialPaused(trial) ? t('workspaces.trial.convertPausedMessage') : t('workspaces.trial.convertMessage')}
        confirmLabel={t('workspaces.trial.convert')}
        onConfirm={() => { setConfirming(false); convert.mutate() }} onCancel={() => setConfirming(false)} />
    </div>
  )
}
