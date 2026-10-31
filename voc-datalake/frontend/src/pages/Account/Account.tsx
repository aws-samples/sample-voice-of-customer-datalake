/**
 * @fileoverview Account (user menu): everything a user configures for
 * THEMSELVES (docs/account-vs-admin.md), on the same top tab bar as the other
 * pages, each tab a deep link `/account?tab=<id>` (`accountSections.ts`):
 * Profile (details, password, sign out) · Preferences (language, theme, Home
 * setup and "How it works", assistant notifications and bubble, this browser)
 * · Morning brief · Objectives (my objectives & KPIs) · Access & tokens (my
 * read-only scope, MCP tokens). Reached from the user chip at the foot of the
 * sidebar. Not admin-gated: every route here is self-scoped server-side.
 *
 * Older links still land: the 5.09–5.11 `?section=<id>` and Company's
 * `?tab=mine` → `?tab=objectives` are replaced by the canonical `?tab=` form
 * (no history entry).
 *
 * @module pages/Account
 */
import type { ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore, useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { useSignOut } from '../../hooks/useSignOut'
import MyContextSection from '../Company/MyContextSection'
import AccessSection from './AccessSection'
import AccountNav from './AccountNav'
import AssistantSection from './AssistantSection'
import BriefSection from './BriefSection'
import BrowserSection from './BrowserSection'
import OnboardingSection from './OnboardingSection'
import PasswordSection from './PasswordSection'
import PasskeySection from './PasskeySection'
import {
  IdentityHeader, McpTokensSection, PreferencesSection, ProfileDetails, SignOutSection,
} from './ProfileSections'
import { accountRedirect, resolveAccountTab } from './accountSections'
import type { AccountTabId } from './accountSections'
import type { AccountUser } from './ProfileSections'

function ObjectivesSection() {
  const { t } = useTranslation('settings')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return configured
    ? <MyContextSection />
    : <div className="card text-sm text-warn bg-warn-subtle border-warn/30">{t('shared.configureFirst')}</div>
}

function SignOut() {
  return <SignOutSection onSignOut={useSignOut()} />
}

/** One tab's cards. */
function TabContent({ tab, user, isAdmin }: Readonly<{ tab: AccountTabId; user: AccountUser; isAdmin: boolean }>) {
  const contents: Readonly<Record<AccountTabId, () => ReactNode>> = {
    profile: () => <><ProfileDetails user={user} isAdmin={isAdmin} /><PasswordSection /><PasskeySection /><SignOut /></>,
    preferences: () => <><PreferencesSection /><OnboardingSection /><AssistantSection /><BrowserSection /></>,
    briefing: () => <BriefSection />,
    objectives: () => <ObjectivesSection />,
    access: () => <><AccessSection isAdmin={isAdmin} /><McpTokensSection /></>,
  }
  return <div className="space-y-4 sm:space-y-6">{contents[tab]()}</div>
}

export default function Account() {
  const { user } = useAuthStore()
  const account = user ?? {}
  const isAdmin = useIsAdmin()
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const sectionParam = searchParams.get('section')
  const redirectTo = accountRedirect(tabParam, sectionParam)
  const tab = resolveAccountTab(tabParam, sectionParam)
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      {redirectTo !== null && <Navigate to={redirectTo} replace />}
      <IdentityHeader user={account} />
      <AccountNav active={tab} />
      <TabContent tab={tab} user={account} isAdmin={isAdmin} />
    </div>
  )
}
