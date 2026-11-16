/**
 * @fileoverview Knowledge → Company — the context every user and every AI
 * surface works from: vision & objectives and the design system.
 *
 * Why its own page rather than Administration tabs: Administration is
 * admin-only operational configuration. This is knowledge everyone reads — the
 * assistant, the autonomous agents and the memory extractor all use it — so it
 * sits in the Knowledge nav section beside Memory. Admins
 * edit; everyone reads. The caller's own objectives & KPIs moved to Account
 * (`/account/objectives`; the header's "My objectives" link). A project's Product tab stays on the project:
 * it is that project's own context and shows this page's company context as a
 * read-only strip.
 *
 * Each tab is a path (`/company/vision`, `/company/design`, `/company/personas`; `/company` is Vision; an unknown
 * tab is replaced by Vision; no `?tab=` link of before is read), so Back walks the tabs. Personas (5.60) is the company persona
 * library: admins write it, projects copy from it.
 *
 * @module pages/Company
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import { Compass, Palette, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { useTabPath } from '../../utils/tabPaths'
import { accountTabPath } from '../Account/accountSections'
import { COMPANY_PAGE, COMPANY_TABS } from './companyPaths'
import type { CompanyTab } from './companyPaths'
import CompanyContextSection from './CompanyContextSection'
import DesignSystemSection from './DesignSystemSection'
import CompanyPersonasSection from './CompanyPersonasSection'

const TAB_ICONS: Record<CompanyTab, LucideIcon> = { vision: Compass, design: Palette, personas: Users }

export default function Company() {
  const { t } = useTranslation('settings')
  const isAdmin = useIsAdmin()
  const { config } = useConfigStore()
  // A tab is a path: the open section's unsaved-changes guard asks before the switch (a route change) leaves it.
  const [tab, setTab] = useTabPath(COMPANY_PAGE)

  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('company.title')}</h1>
        <p className="text-sm text-muted mt-1">{t('company.subtitle')}</p>
        <p className="text-sm text-muted mt-1">
          {t('company.myObjectivesHint')}{' '}
          <Link to={accountTabPath('objectives')} className="link">{t('company.myObjectivesLink')}</Link>
        </p>
      </div>
      <IconTabs tabs={COMPANY_TABS} active={tab} icons={TAB_ICONS} label={t('company.title')}
        labelOf={(id) => t(`company.tabs.${id}`)} onSelect={setTab} />
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
