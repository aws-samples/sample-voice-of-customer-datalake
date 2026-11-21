/**
 * @fileoverview The trial banner (7.71.00; docs/multi-workspace.md "Trial workspaces"): every member of a trial
 * workspace sees, above every page, when the trial ends and what happens then (it pauses: plugins and live forms
 * stop, nothing is deleted, reads and the export keep working), or, once it paused, since when and what the pause
 * turned off. A converted trial, or a workspace that is no trial, shows nothing. It also keeps the trial store
 * (currentTrial.ts) in step with `GET /me/workspaces/current`, so the controls a pause holds back can say why.
 *
 * @module workspace/TrialBanner
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CirclePause, Hourglass } from 'lucide-react'
import Notice from '../components/Notice/Notice'
import { formatDate } from '../utils/dateUtils'
import { useCurrentWorkspace } from './currentWorkspace'
import { isTrialPaused, setCurrentTrial, useCurrentTrial } from './currentTrial'
import { useServerWorkspace } from './useMyWorkspaces'

/** Keep the trial store in step with the server's answer for the current workspace. */
function useTrialSync(): void {
  const workspace = useCurrentWorkspace()
  const server = useServerWorkspace(workspace?.id ?? null)
  const answer = workspace !== null && server.data?.id === workspace.id ? server.data : null
  const trial = answer?.trial ?? null
  const playbook = answer?.playbook ?? null
  useEffect(() => { setCurrentTrial({ trial, playbook }) }, [trial, playbook])
}

export default function TrialBanner() {
  const { t, i18n } = useTranslation()
  useTrialSync()
  const trial = useCurrentTrial()
  if (trial?.converted_at !== null) return null
  if (isTrialPaused(trial)) {
    const paused = trial.paused ?? { plugins: 0, forms: 0 }
    return (
      <Notice variant="banner" tone="warn" role="note" icon={CirclePause} className="mx-4 mt-4"
        text={t('workspaces.trial.banner.paused', {
          date: formatDate(trial.paused_at, i18n.language), plugins: paused.plugins, forms: paused.forms,
        })} />
    )
  }
  if (trial.expires_at === null) return null
  return (
    <Notice variant="banner" tone="warn" role="note" icon={Hourglass} className="mx-4 mt-4"
      text={t('workspaces.trial.banner.running', { date: formatDate(trial.expires_at, i18n.language) })} />
  )
}
