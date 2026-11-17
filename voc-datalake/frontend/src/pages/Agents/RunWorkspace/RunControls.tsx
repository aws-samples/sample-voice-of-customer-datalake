/**
 * @fileoverview The run's own controls (7.51.00), an admin's where the deployment lets the workspace reach the run
 * (`actions_available`; else one line says why there are none): on a run under way, the run monitor's signals to
 * the whole run (Pause, Resume, Shut down, Stop now: EngineeringSignals.tsx); on an ended run, Restart run, which
 * starts a child run of it (RestartRunDialog.tsx).
 *
 * @module pages/Agents/RunWorkspace/RunControls
 */
import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EngineeringSignals } from '../EngineeringSignals'
import { RestartRunDialog } from './RestartRunDialog'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

export function RunControls({ runId, overview, live, isAdmin }: Readonly<{
  runId: string; overview: EngineeringOverview; live: boolean; isAdmin: boolean
}>) {
  const { t } = useTranslation('agents')
  const [restarting, setRestarting] = useState(false)
  if (!isAdmin) return null
  if (!overview.actions_available) return <p className="card text-sm text-muted">{t('engineeringRun.actionsUnavailable')}</p>
  return (
    <section className="card space-y-2" aria-labelledby="run-workspace-controls">
      <h2 id="run-workspace-controls" className="text-sm font-medium text-text-strong">{t('engineeringRun.runSignals')}</h2>
      {live ? <EngineeringSignals runId={runId} /> : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted">{t('runWorkspace.restartRun.ended')}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRestarting(true)}>
            <RotateCcw size={14} aria-hidden="true" /> {t('runWorkspace.restartRun.open')}
          </button>
        </div>
      )}
      {restarting && <RestartRunDialog runId={runId} agents={overview.agents} onClose={() => setRestarting(false)} />}
    </section>
  )
}
