/**
 * @fileoverview Knowledge → Company — the context every user and every AI
 * surface works from: vision & objectives and the design system.
 *
 * Why its own page rather than Administration tabs: Administration is
 * admin-only operational configuration. This is knowledge everyone reads — the
 * assistant, the autonomous agents and the memory extractor all use it — so it
 * sits in the Knowledge nav section beside Memory. Admins
 * edit; everyone reads. The caller's own objectives & KPIs moved to Account
 * (`?tab=mine` redirects there). A project's Product tab stays on the project:
 * it is that project's own context and shows this page's company context as a
 * read-only strip.
 *
 * `?tab=design` / `?tab=personas` deep-links a tab. Personas (5.60) is the company persona
 * library: admins write it, projects copy from it.
 *
 * @module pages/Company
 */
import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Compass, Palette, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useGuardedAction } from '../../components/UnsavedChangesGuard/guardRegistry'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import CompanyContextSection from './CompanyContextSection'
import DesignSystemSection from './DesignSystemSection'
import CompanyPersonasSection from './CompanyPersonasSection'

const COMPANY_TABS = ['vision', 'design', 'personas'] as const
type CompanyTab = typeof COMPANY_TABS[number]

const TAB_ICONS: Record<CompanyTab, LucideIcon> = { vision: Compass, design: Palette, personas: Users }

function isCompanyTab(value: string | null): value is CompanyTab {
  return COMPANY_TABS.some((tab) => tab === value)
}

export default function Company() {
  const { t } = useTranslation('settings')
  const isAdmin = useIsAdmin()
  const { config } = useConfigStore()
  const [searchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  const [tab, setTab] = useState<CompanyTab>(isCompanyTab(requested) ? requested : 'vision')
  // Tabs are local state, not navigation: route the switch through the open section's guard.
  const guarded = useGuardedAction()
  if (requested === 'mine') return <Navigate to="/account?tab=objectives" replace />

  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('company.title')}</h1>
        <p className="text-sm text-muted mt-1">{t('company.subtitle')}</p>
        <p className="text-sm text-muted mt-1">
          {t('company.myObjectivesHint')}{' '}
          <Link to="/account?tab=objectives" className="link">{t('company.myObjectivesLink')}</Link>
        </p>
      </div>
      <div className="tabs-rail overflow-x-auto">
        <div className="tabs-track" role="tablist" aria-label={t('company.title')}>
          {COMPANY_TABS.map((id) => {
            const Icon = TAB_ICONS[id]
            return (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => guarded(() => setTab(id))} className={clsx('tab', tab === id && 'tab-active')}>
                <Icon size={14} /> {t(`company.tabs.${id}`)}
              </button>
            )
          })}
        </div>
      </div>
      {config.apiEndpoint ? <CompanyTabContent tab={tab} isAdmin={isAdmin} /> : (
        <div className="card text-sm text-warn bg-warn-subtle border-warn/30">{t('shared.configureFirst')}</div>
      )}
    </div>
  )
}

function CompanyTabContent({ tab, isAdmin }: Readonly<{ tab: CompanyTab; isAdmin: boolean }>) {
  if (tab === 'design') return <DesignSystemSection isAdmin={isAdmin} />
  // Who may write the library is the API's answer (`can_edit`), not this page's guess.
  if (tab === 'personas') return <CompanyPersonasSection />
  return <CompanyContextSection isAdmin={isAdmin} />
}
