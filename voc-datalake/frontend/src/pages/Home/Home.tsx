/**
 * @fileoverview Home — the app's landing route ("/"), the reader's morning brief.
 *
 * In order: "Good morning, <name>" with the brief's freshness, Refresh and
 * Settings (a link to Account → Morning brief, where the brief settings live:
 * docs/account-vs-admin.md); live agent-decision cards (agents whose last run
 * waits for a person); while the reader is not subscribed, the compact
 * "Subscribe to the morning brief" call to action (hour + Subscribe); three
 * metric tiles; the brief's cards; "Things to do"; the setup checklist (first
 * on a fresh install with no feedback yet); and "How it works". The brief is
 * the reader's own (`/settings/my-briefing/*`, docs/briefing.md): nothing is
 * built until they subscribe or press Refresh.
 *
 * The two sections are collapsible and start expanded. The checklist and
 * "How it works" each have a Skip, stored per user on the server
 * (`/settings/my-onboarding` `state: skipped` / `guide: skipped`): a skipped
 * section starts collapsed, and expanding it un-skips it.
 *
 * The decision cards and the subscribe card each have an X that closes them for
 * this user (`/settings/my-onboarding`: `dismiss_decision_run` per waiting run,
 * `subscribe_prompt: dismissed`); a later waiting run shows its card again, and
 * Account → Morning brief still subscribes.
 *
 * The per-user start page ("Open the dashboard when I sign in") is set on
 * Account only. With it on, opening the app — a fresh load of "/" or the
 * redirect after sign-in (`utils/landing`) — goes straight to the dashboard;
 * the sidebar's Home link still shows this page.
 *
 * Namespaces: `briefing` (the brief) and `dashboard` (`home.*`, the checklist).
 *
 * @module pages/Home
 */

import { ListChecks } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'
import CollapsibleSection from '../../components/CollapsibleSection/CollapsibleSection'
import { useCanSetUp } from '../../components/ScopeNotice/useViewerScope'
import { isMenuItemEnabled } from '../../config/menuConfig'
import { useAgentsAwaitingDecision } from '../../hooks/useAgentsNeedingDecision'
import { useConfigStore } from '../../store/configStore'
import { isLanding } from '../../utils/landing'
import AgentDecisionCards from './brief/AgentDecisionCards'
import BriefHeader, { RefreshButton, SettingsLink } from './brief/BriefHeader'
import { BriefSubscribe } from './brief/BriefSettings'
import MorningBrief from './brief/MorningBrief'
import { useBrief } from './brief/useBrief'
import { useBriefPreferences } from './brief/useBriefPreferences'
import HowItWorks from './HowItWorks'
import OnboardingBuddy from './onboarding/OnboardingBuddy'
import { useOnboardingPreference } from './onboarding/useOnboardingPreference'
import { useSkippableOpen } from './useSkippableOpen'
import type { OnboardingPreferenceResult } from './onboarding/useOnboardingPreference'
import type { Agent } from '../../api/agentsApi'
import type { OnboardingPreference, StartPage } from '../../api/onboardingApi'

/** The checklist is on Home: shown, or skipped (collapsed). Hidden / dismissed take it off. */
const checklistOnHome = (preference: OnboardingPreference) => preference.visible || preference.state === 'skipped'

/** The way back to the checklist once it is off Home (nothing while it is on Home). */
function ShowChecklist({ onboarding }: Readonly<{ onboarding: OnboardingPreferenceResult }>) {
  const { t } = useTranslation('dashboard')
  const { preference, setState, isSaving, saveFailed } = onboarding
  if (checklistOnHome(preference)) return null
  return (
    <div className="mt-4 space-y-2">
      <button type="button" className="btn btn-secondary btn-sm" disabled={isSaving} onClick={() => setState('active')}>
        <ListChecks size={14} aria-hidden="true" />
        {t('home.buddy.show')}
      </button>
      {saveFailed && <p role="alert" className="text-sm text-danger">{t('home.buddy.saveFailed')}</p>}
    </div>
  )
}

/** The waiting agents whose current run the reader has not closed on Home. */
function openDecisions(agents: readonly Agent[], dismissedRuns: readonly string[]): Agent[] {
  const closed = new Set(dismissedRuns)
  return agents.filter((agent) => !closed.has(agent.stats.last_run_id ?? ''))
}

type LandingDecision = 'wait' | 'redirect' | 'stay'

function decide(landing: boolean, isResolving: boolean, startPage: StartPage): LandingDecision {
  if (!landing) return 'stay'
  if (isResolving) return 'wait'
  return startPage === 'dashboard' ? 'redirect' : 'stay'
}

/**
 * Whether this visit goes on to the dashboard, decided ONCE per visit: when the
 * start page is first known. Turning the switch on while reading Home must not
 * yank the user away mid-visit; it applies the next time the app opens.
 */
function useLandingDecision(isResolving: boolean, startPage: StartPage): LandingDecision {
  const landing = isLanding(useLocation())
  const [decision, setDecision] = useState<LandingDecision>(() => decide(landing, isResolving, startPage))
  if (decision === 'wait' && !isResolving) {
    // Derived state, settled during render (no effect, no flash).
    setDecision(decide(landing, false, startPage))
  }
  return decision
}

/** "Your setup checklist": expanded unless skipped; expanding a skipped one makes it active again. */
function Checklist({ onboarding }: Readonly<{ onboarding: OnboardingPreferenceResult }>): ReactNode {
  const { t } = useTranslation('dashboard')
  const { preference, setState, isSaving, saveFailed } = onboarding
  const section = useSkippableOpen(preference.state === 'skipped', () => { setState('active') })
  return (
    <CollapsibleSection title={t('home.buddy.title')} open={section.open} onOpenChange={section.onOpenChange}>
      <OnboardingBuddy signals={preference.signals} isSaving={isSaving} saveFailed={saveFailed}
        onChoose={(state) => { section.followServer(); setState(state) }} />
    </CollapsibleSection>
  )
}

/** Until the reader subscribes (or closes it), Home offers the compact call to action (the settings live on Account). */
function SubscribeCallToAction({ onboarding }: Readonly<{ onboarding: OnboardingPreferenceResult }>) {
  const settings = useBriefPreferences()
  if (onboarding.isResolving || onboarding.preference.subscribe_prompt === 'dismissed') return null
  if (settings.isLoading || settings.preferences.enabled) return null
  return <BriefSubscribe settings={settings} onClose={onboarding.dismissSubscribePrompt} />
}

export default function Home() {
  const onboarding = useOnboardingPreference()
  const { preference, isResolving } = onboarding
  const visit = useLandingDecision(isResolving, preference.start_page)
  const brief = useBrief()
  const agentsEnabled = useConfigStore((s) => s.config.apiEndpoint) !== '' && isMenuItemEnabled('agents')
  const decisions = useAgentsAwaitingDecision(agentsEnabled)
  const canSetUp = useCanSetUp()
  const [now] = useState(() => new Date())
  const showBuddy = !isResolving && checklistOnHome(preference)
  // First on a fresh install, but only for the administrator who sets it up: a
  // regular or restricted viewer's checklist has no setup steps to put first.
  const fresh = canSetUp && !preference.signals.feedback_present

  // Opening the app (not clicking Home) honours the start page; wait for the
  // answer rather than flash Home on the way to the dashboard.
  if (visit === 'wait') return null
  if (visit === 'redirect') return <Navigate to="/dashboard" replace />

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-8">
      <BriefHeader brief={brief.brief} now={now}>
        <RefreshButton generating={brief.generating} outcome={brief.refreshOutcome} onRefresh={brief.refresh}>
          <SettingsLink />
        </RefreshButton>
        {!isResolving && <ShowChecklist onboarding={onboarding} />}
      </BriefHeader>

      <AgentDecisionCards agents={openDecisions(decisions, preference.dismissed_decision_runs)}
        onClose={onboarding.dismissDecisionRun} />

      {/* Nothing in this slot until the server (or the cache) answers: no flash of a buddy the user turned off. */}
      {showBuddy && fresh && <Checklist onboarding={onboarding} />}

      <SubscribeCallToAction onboarding={onboarding} />
      <MorningBrief result={brief} liveAgentDecisions={decisions.length > 0} />

      {showBuddy && !fresh && <Checklist onboarding={onboarding} />}

      <HowItWorks guide={preference.guide} onGuideChange={onboarding.setGuide} isSaving={onboarding.isSaving} />
    </div>
  )
}
