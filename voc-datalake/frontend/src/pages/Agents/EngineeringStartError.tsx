/**
 * @fileoverview An engineering agent's start that failed (7.47.00: Run now, or Build from this PRD): the server's own
 * words (not set up, a run in progress, the runtime's refusal), and, when its engineering run was written or may have
 * been, a way to it, never "start it again" (startRunRules.ts `startOutcomeOf`).
 *
 * @module pages/Agents/EngineeringStartError
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { serverReason } from '../../lib/errors'
import { startOutcomeOf } from './startRunRules'
import { engineeringRunPagePath } from './workflowPaths'

export function EngineeringStartError({ error }: Readonly<{ error: unknown }>) {
  const { t } = useTranslation('agents')
  const outcome = startOutcomeOf(error)
  return (
    <div role="alert" className="space-y-1 text-[12px] text-danger">
      <p>{outcome?.kind === 'unknown' ? t('startRun.mayHaveStarted') : serverReason(error) ?? t('run.startFailed')}</p>
      {outcome?.kind === 'named' && (
        <Link className="link font-medium" to={engineeringRunPagePath(outcome.runId)}>{t('startRun.openRun')}</Link>
      )}
    </div>
  )
}
