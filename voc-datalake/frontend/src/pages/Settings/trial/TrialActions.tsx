/**
 * @fileoverview A trial workspace's row in the platform console (7.71.00; docs/multi-workspace.md "Trial workspaces"):
 * its state (running until its end, paused since, or converted), and, until it is converted, Extend (14, 30 or 60 more
 * days: a paused trial's plugins and forms are turned back on) and Convert (a regular workspace from then on, after a
 * confirmation). After either, the forms the resume left off are named with why (7.71.01: `resumed.skipped`), so
 * their editors can fix and publish them. Neither deletes anything, and nor does the trial's end: it only pauses.
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
import type { PlatformWorkspace, TrialDays, TrialResumed } from '../../../api/platformWorkspacesApi'
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

/** The publish rules a resume asks again (lambda/shared/trial_pause.py `resume`), each with what an admin reads. */
const STAYED_OFF_KEYS: Readonly<Record<string, string>> = {
  theme_unreadable: 'workspaces.trial.stayedOff.themeUnreadable',
  unresolved_placeholder: 'workspaces.trial.stayedOff.unresolvedPlaceholder',
}

/** The forms an extension or a conversion left off, each with why; nothing when it left none off. */
function StayedOff({ resumed }: Readonly<{ resumed: TrialResumed | null }>) {
  const { t } = useTranslation()
  const skipped = resumed?.skipped ?? []
  if (skipped.length === 0) return null
  return (
    <div role="status" className="text-xs text-warn">
      <p>{t('workspaces.trial.stayedOff.title')}</p>
      <ul className="list-disc pl-4">
        {skipped.map((form) => (
          <li key={form.form_id}>
            {t(STAYED_OFF_KEYS[form.code] ?? 'workspaces.trial.stayedOff.other', { name: form.name || form.form_id })}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Extend and Convert for a trial that is not converted, then the forms the last of them left off; nothing else. */
export default function TrialActions({ workspace }: Readonly<{ workspace: PlatformWorkspace }>) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const extendId = useId()
  const [days, setDays] = useState<TrialDays>(DEFAULT_TRIAL_DAYS)
  const [confirming, setConfirming] = useState(false)
  const [resumed, setResumed] = useState<TrialResumed | null>(null)
  const settled = () => queryClient.invalidateQueries({ queryKey: platformWorkspacesKey() })
  const extend = useMutation({ mutationFn: (more: TrialDays) => platformWorkspacesApi.extendTrial(workspace.id, more),
    onSuccess: (view) => setResumed(view.resumed), onSettled: settled })
  const convert = useMutation({ mutationFn: () => platformWorkspacesApi.convertTrial(workspace.id),
    onSuccess: (view) => setResumed(view.resumed), onSettled: settled })
  const trial = workspace.trial
  // A converted trial offers nothing more, but still says what its conversion left off.
  if (trial?.converted_at !== null) return <StayedOff resumed={resumed} />
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
      <StayedOff resumed={resumed} />
      <ConfirmModal isOpen={confirming} variant="warning" title={t('workspaces.trial.convertTitle', { name: workspace.name })}
        message={isTrialPaused(trial) ? t('workspaces.trial.convertPausedMessage') : t('workspaces.trial.convertMessage')}
        confirmLabel={t('workspaces.trial.convert')}
        onConfirm={() => { setConfirming(false); convert.mutate() }} onCancel={() => setConfirming(false)} />
    </div>
  )
}
