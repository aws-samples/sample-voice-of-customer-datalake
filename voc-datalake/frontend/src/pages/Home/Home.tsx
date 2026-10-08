/**
 * @fileoverview Home — the app's landing route ("/").
 *
 * While the onboarding buddy is visible (the caller's server-side preference,
 * `/settings/my-onboarding`), Home is the getting-started page: the welcome
 * hero, the self-checking setup checklist (`onboarding/OnboardingBuddy`) and
 * the product-development flow the sidebar is organized around (AI-PDLC
 * phases: Sources → Signals → Ideation → Validation). Once the user hides,
 * skips or turns the buddy off, Home is the normal home: the same hero and
 * flow and a way to bring the checklist back (also on the Account page).
 *
 * Either way the hero offers the dashboard and "Open the dashboard when I sign
 * in" (the per-user start page). With that on, opening the app — a fresh load
 * of "/" or the redirect after sign-in (`utils/landing`) — goes straight to the
 * dashboard; the sidebar's Home link still shows this page.
 *
 * Uses the `dashboard` i18n namespace (`home.*`, `home.buddy.*`); sidebar nav
 * labels come from `common` via explicit `common:` key prefixes.
 *
 * @module pages/Home
 */

import {
  Globe,
  Database,
  FolderOpen,
  SearchX,
  Bot,
  Briefcase,
  FileText,
  LayoutDashboard,
  ListChecks,
  ListOrdered,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useIsAdmin } from '../../store/authStore'
import { isLanding } from '../../utils/landing'
import OnboardingBuddy from './onboarding/OnboardingBuddy'
import StartPageSwitch from './onboarding/StartPageSwitch'
import { useOnboardingPreference } from './onboarding/useOnboardingPreference'
import type { OnboardingPreferenceResult } from './onboarding/useOnboardingPreference'
import type { StartPage } from '../../api/onboardingApi'

/** A link chip inside a phase card, pointing at the relevant sidebar section. */
interface PhaseLink {
  to: string
  /** i18n key (uses `common:` prefix to reuse the sidebar nav labels). */
  labelKey: string
  icon: LucideIcon
  /** Hidden for non-admins, mirroring the sidebar's `adminOnly` items. */
  adminOnly?: boolean
}

/** One step of the product-development flow, mapped to an AI-PDLC phase. */
interface Phase {
  num: number
  titleKey: string
  descKey: string
  links: PhaseLink[]
}

/**
 * The four workflow phases, in order. Link targets mirror the sidebar sections
 * so the guide and the nav stay in lockstep (Sources → Signals → Ideation →
 * Validation).
 */
const PHASES: Phase[] = [
  {
    num: 1,
    titleKey: 'home.phase1Title',
    descKey: 'home.phase1Desc',
    links: [
      { to: '/scrapers', labelKey: 'common:nav.scrapers', icon: Globe },
      // Admin-only route (raw S3 cannot be filtered by category access).
      { to: '/data-explorer', labelKey: 'common:nav.dataExplorer', icon: Database, adminOnly: true },
    ],
  },
  {
    num: 2,
    titleKey: 'home.phase2Title',
    descKey: 'home.phase2Desc',
    links: [
      // No `/feedback` link here: that route and its `nav.feedback` label were
      // both removed when the standalone Feedback list was consolidated into
      // Categories (issue #198), so the chip rendered the raw key text.
      { to: '/categories', labelKey: 'common:nav.categories', icon: FolderOpen },
      { to: '/problems', labelKey: 'common:nav.problemAnalysis', icon: SearchX },
    ],
  },
  {
    num: 3,
    titleKey: 'home.phase3Title',
    descKey: 'home.phase3Desc',
    links: [
      { to: '/chat', labelKey: 'common:nav.aiChat', icon: Bot },
      { to: '/projects', labelKey: 'common:nav.projects', icon: Briefcase },
    ],
  },
  {
    num: 4,
    titleKey: 'home.phase4Title',
    descKey: 'home.phase4Desc',
    links: [
      { to: '/feedback-forms', labelKey: 'common:nav.feedbackForms', icon: FileText },
      { to: '/prioritization', labelKey: 'common:nav.prioritization', icon: ListOrdered },
    ],
  },
]

function PhaseCard({ phase }: Readonly<{ phase: Phase }>) {
  const { t } = useTranslation('dashboard')
  const isAdmin = useIsAdmin()
  const links = phase.links.filter((link) => link.adminOnly !== true || isAdmin)
  return (
    <div className="flex gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent font-mono text-sm font-bold text-accent-fg">
        {phase.num}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t(phase.titleKey)}</h3>
        <p className="mt-1 text-sm text-muted">{t(phase.descKey)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((link) => {
            const Icon = link.icon
            return (
              <Link
                key={link.to}
                to={link.to}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-accent px-2.5 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent/30 hover:bg-accent-subtle hover:text-accent-text focus-ring"
              >
                <Icon size={14} className="flex-shrink-0" />
                {t(link.labelKey)}
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The hero's actions: always the dashboard and the start-page switch; the way back to the checklist once it is off. */
function HomeActions({ onboarding }: Readonly<{ onboarding: OnboardingPreferenceResult }>) {
  const { t } = useTranslation('dashboard')
  const { preference, setState, setStartPage, isSaving, saveFailed } = onboarding
  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-wrap gap-2">
          <Link to="/dashboard" className="btn btn-primary btn-sm">
            <LayoutDashboard size={14} aria-hidden="true" />
            {t('home.buddy.openDashboard')}
          </Link>
          {!preference.visible && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={isSaving} onClick={() => setState('active')}>
              <ListChecks size={14} aria-hidden="true" />
              {t('home.buddy.show')}
            </button>
          )}
        </div>
        <StartPageSwitch startPage={preference.start_page} onChange={setStartPage} disabled={isSaving} />
      </div>
      {/* While the buddy shows, it reports a failed save itself. */}
      {saveFailed && !preference.visible && <p role="alert" className="text-sm text-danger">{t('home.buddy.saveFailed')}</p>}
    </div>
  )
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

export default function Home() {
  const { t } = useTranslation('dashboard')
  const onboarding = useOnboardingPreference()
  const { preference, isResolving, setState, isSaving, saveFailed } = onboarding
  const visit = useLandingDecision(isResolving, preference.start_page)
  const showBuddy = !isResolving && preference.visible

  // Opening the app (not clicking Home) honours the start page; wait for the
  // answer rather than flash Home on the way to the dashboard.
  if (visit === 'wait') return null
  if (visit === 'redirect') return <Navigate to="/dashboard" replace />

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-8">
      {/* Hero */}
      <header className="pt-2">
        {showBuddy && (
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-accent-subtle px-3 py-1 text-xs font-medium text-accent-text">
            <Sparkles size={14} aria-hidden="true" />
            {t('home.badge')}
          </div>
        )}
        <h1 className="text-2xl font-bold tracking-tight text-text-strong sm:text-3xl">{t('home.title')}</h1>
        <p className="mt-2 text-text">{t('home.intro')}</p>
        {!isResolving && <HomeActions onboarding={onboarding} />}
      </header>

      {/* Nothing in this slot until the server (or the cache) answers: no flash of a buddy the user turned off. */}
      {showBuddy && (
        <OnboardingBuddy signals={preference.signals} onChoose={setState} isSaving={isSaving} saveFailed={saveFailed} />
      )}

      {/* Workflow flow */}
      <section>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-text-strong">{t('home.howItWorks')}</h2>
        </div>
        <p className="mb-4 text-sm text-muted">{t('home.flowHint')}</p>
        <div className="space-y-3">
          {PHASES.map((phase) => (
            <PhaseCard key={phase.num} phase={phase} />
          ))}
        </div>
      </section>
    </div>
  )
}
