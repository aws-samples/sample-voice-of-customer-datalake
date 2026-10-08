/**
 * @fileoverview Account (user menu, todofeatures §6.1) — one page holding
 * everything a user configures for THEMSELVES: profile, password, language &
 * theme, their own objectives & KPIs (moved from Knowledge → Company), MCP
 * tokens (Connect) and sign out. Reached from the user chip at the foot of the
 * sidebar. Not admin-gated: every route here is self-scoped server-side.
 *
 * `?tab=objectives` (the old tab deep link, still used by Company `?tab=mine`)
 * scrolls to the objectives section.
 *
 * @module pages/Account
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { companyContextApi, myContextKey } from '../../api/companyContextApi'
import { useAuthStore, useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { useSignOut } from '../../hooks/useSignOut'
import MyContextSection from '../Company/MyContextSection'
import OnboardingSection from './OnboardingSection'
import PasswordSection from './PasswordSection'
import {
  IdentityHeader, McpTokensSection, PreferencesSection, ProfileDetails, SignOutSection,
} from './ProfileSections'

const OBJECTIVES_SECTION_ID = 'objectives'

export default function Account() {
  const { user } = useAuthStore()
  const isAdmin = useIsAdmin()
  const signOut = useSignOut()
  const account = user ?? {}
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <IdentityHeader user={account} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 items-start">
        <ProfileDetails user={account} isAdmin={isAdmin} />
        <PreferencesSection />
      </div>
      <PasswordSection />
      <ObjectivesSection />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 items-start">
        <McpTokensSection />
        <OnboardingSection />
      </div>
      <SignOutSection onSignOut={signOut} />
    </div>
  )
}

function ObjectivesSection() {
  const { t } = useTranslation('settings')
  const { config } = useConfigStore()
  const configured = config.apiEndpoint !== ''
  return (
    <ScrollTargetOnDeepLink loaded={useMyContextLoaded(configured)}>
      {configured
        ? <MyContextSection />
        : <div className="card text-sm text-warn bg-warn-subtle border-warn/30">{t('shared.configureFirst')}</div>}
    </ScrollTargetOnDeepLink>
  )
}

/**
 * Observes the same cache entry MyContextSection fetches (one request, two
 * observers), so the deep-link scroll can wait for the objectives to render.
 */
function useMyContextLoaded(enabled: boolean): boolean {
  const query = useQuery({ queryKey: myContextKey(), queryFn: companyContextApi.getMyContext, enabled })
  return !enabled || !query.isPending
}

/**
 * `?tab=objectives` scrolls here once, AFTER the objectives have loaded:
 * scrolling while they are still a spinner clamps the scroll to the then-short
 * page, leaving the section half a screen down once the list renders.
 */
function ScrollTargetOnDeepLink({ loaded, children }: Readonly<{ loaded: boolean; children: ReactNode }>) {
  const [searchParams] = useSearchParams()
  const ref = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  const deepLinked = searchParams.get('tab') === OBJECTIVES_SECTION_ID

  useEffect(() => {
    if (!deepLinked || !loaded || scrolled.current) return
    scrolled.current = true
    ref.current?.scrollIntoView({ block: 'start' })
  }, [deepLinked, loaded])

  return <div id={OBJECTIVES_SECTION_ID} ref={ref} className="scroll-mt-4">{children}</div>
}
