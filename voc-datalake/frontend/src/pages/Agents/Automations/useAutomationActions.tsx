/**
 * @fileoverview What an automation's row and its page do (7.52.00 C1; ux-agents-redesign part 1 §2.3, part 2 S6): the one
 * primary of its state (automationState.ts) and the ⋯ menu's actions, with the dialogs they open and the line each
 * leaves (`role="status"` for a success, `role="alert"` for a refusal, under the state chip).
 *
 * - **Set up** and **Change setup…** open the Set up drawer (SetupDrawer.tsx); "N to fix" opens it at its readiness.
 * - **Enable** is instant ("Issue triage enabled. Runs as you."); a 409 opens the drawer at the checks.
 * - **Pause** and **Resume** (7.52.00, `POST /agents/<id>/pause|resume`, audited by the server, who and when).
 * - **Turn off** (`POST …/disable`; it also ends a pause).
 * - **Run now** asks first (RunNowConfirm.tsx: an engineering automation's issue or PRD).
 * - **Review** opens the automation's runs, where the run waiting for a person is decided.
 * - **Fix** (Can't run): the drawer, or Connections when no connection it can use is left.
 * - **Rename…** and **Delete…** (the list) or **Archive…** (its page): the automation is archived, never erased.
 *
 * @module pages/Agents/Automations/useAutomationActions
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { isEngineeringAgent } from '../../../api/agentsApi'
import { failingChecksOf } from '../../../api/engineeringReadinessApi'
import { serverReason } from '../../../lib/errors'
import { agentPath, agentsPath } from '../agentsPaths'
import { RunNowConfirm } from '../RunNowConfirm'
import { useAgentMutations } from '../useAgents'
import { SetupDrawer } from './SetupDrawer'
import { NameAndRemoval } from './AutomationDialogs'
import type { Removal } from './AutomationDialogs'
import type { ReactNode } from 'react'
import type { Agent, RunNowBody } from '../../../api/agentsApi'
import type { AutomationPrimary } from './automationState'
import type { DrawerFocus } from './SetupDrawer'


export interface AutomationActions {
  readonly primary: (action: AutomationPrimary) => void
  readonly openSetup: (focus: DrawerFocus) => void
  readonly pause: () => void
  readonly resume: () => void
  readonly turnOff: () => void
  readonly runNow: () => void
  readonly rename: () => void
  readonly remove: () => void
  /** A write is on its way (the primary waits: `aria-disabled` and a spinner). */
  readonly pending: boolean
  /** The last success, in words (`role="status"`), or ''. */
  readonly notice: string
  /** The last refusal, in words (`role="alert"`), or ''. */
  readonly error: string
  /** The drawer and the dialogs open over the page. */
  readonly overlays: ReactNode
}

type Dialog = { kind: 'setup'; focus: DrawerFocus } | { kind: 'runNow' } | { kind: 'rename' } | { kind: 'remove' } | null

/** The words of a refusal: an Enable's failing checks open the drawer instead (the caller), else the server's. */
const refusalOf = (error: unknown, fallback: string): string => serverReason(error) ?? fallback

/** The writes' feedback: what to say, and the setters the actions use. */
function useFeedback() {
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const say = (text: string) => { setError(''); setNotice(text) }
  const refuse = (text: string) => { setNotice(''); setError(text) }
  return { notice, error, say, refuse, clear: () => { setNotice(''); setError('') } }
}

/** The actions of `agent` (module doc); `connectionUsable`: a Fix opens the drawer (else Connections). */
export function useAutomationActions(agent: Agent, { removal, connectionUsable, onRemoved }: Readonly<{
  removal: Removal; connectionUsable: boolean; onRemoved?: () => void
}>): AutomationActions {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const mutations = useAgentMutations(agent.agent_id)
  const { setEnabled, setPaused, runNow } = mutations
  const [dialog, setDialog] = useState<Dialog>(null)
  const feedback = useFeedback()
  const { name } = agent
  const engineering = isEngineeringAgent(agent)
  const openSetup = (focus: DrawerFocus) => { feedback.clear(); setDialog({ kind: 'setup', focus }) }
  const enable = () => setEnabled.mutate(true, {
    onSuccess: () => feedback.say(engineering ? t('automations.notice.enabledRunsAsYou', { name }) : t('automations.notice.enabled', { name })),
    onError: (error) => {
      if ((failingChecksOf(error)?.length ?? 0) > 0) openSetup('readiness')
      else feedback.refuse(refusalOf(error, t('engineeringAgent.enableFailed')))
    },
  })
  const paused = (to: boolean) => () => setPaused.mutate(to, {
    onSuccess: () => feedback.say(to ? t('automations.notice.paused', { name }) : t('automations.notice.resumed', { name })),
    onError: (error) => feedback.refuse(refusalOf(error, t('automations.pauseFailed'))),
  })
  const turnOff = () => setEnabled.mutate(false, {
    onSuccess: () => feedback.say(t('automations.notice.turnedOff', { name })),
    onError: (error) => feedback.refuse(refusalOf(error, t('detail.toggleFailed'))),
  })
  const startRun = (body?: RunNowBody) => runNow.mutate(body, {
    onSuccess: () => { setDialog(null); feedback.say(t('automations.notice.started', { name })) },
    onError: (error) => { setDialog(null); feedback.refuse(refusalOf(error, t('run.startFailed'))) },
  })
  const openRunNow = () => { feedback.clear(); runNow.reset(); setDialog({ kind: 'runNow' }) }
  const fix = () => {
    if (connectionUsable) openSetup('fields')
    else void navigate(agentsPath({ view: 'connections' }))
  }
  const PRIMARY: Readonly<Record<AutomationPrimary, () => void>> = {
    set_up: () => openSetup('fields'),
    fix,
    resume: paused(false),
    enable,
    run_now: openRunNow,
    review: () => { void navigate(agentPath(agent.agent_id, 'runs')) },
  }
  const close = () => setDialog(null)
  return {
    primary: (action) => { PRIMARY[action]() },
    openSetup,
    pause: paused(true),
    resume: paused(false),
    turnOff,
    runNow: openRunNow,
    rename: () => { mutations.update.reset(); setDialog({ kind: 'rename' }) },
    remove: () => { mutations.archive.reset(); setDialog({ kind: 'remove' }) },
    pending: setEnabled.isPending || setPaused.isPending || runNow.isPending,
    notice: feedback.notice,
    error: feedback.error,
    overlays: (
      <>
        {dialog?.kind === 'setup' && (
          <SetupDrawer agent={agent} focus={dialog.focus} onClose={close}
            onSaved={(_saved, enabled) => {
              close()
              feedback.say(enabled ? t('automations.notice.enabledRunsAsYou', { name }) : t('automations.notice.saved', { name }))
            }} />
        )}
        {dialog?.kind === 'runNow' && <RunNowConfirm agent={agent} starting={runNow.isPending} onConfirm={startRun} onCancel={close} />}
        <NameAndRemoval agent={agent} open={dialog?.kind === 'rename' || dialog?.kind === 'remove' ? dialog.kind : null}
          removal={removal} mutations={mutations} onClose={close}
          onRemoved={() => { onRemoved?.() }} />
      </>
    ),
  }
}
