/**
 * @fileoverview The page of each Administration tab (7.54.00): its cards, in order, each section's card wrapped in its
 * anchor (SectionAnchor.tsx) so a path naming it focuses it. An admin-only card renders nothing for anyone else, even
 * when a link names it (adminTabs.ts already sends such a link to its tab).
 * @module pages/Settings/AdminSectionContent
 */
import { useTranslation } from 'react-i18next'
import UserAdmin from '../../components/UserAdmin/UserAdmin'
import LogsSection from './LogsSection'
import AiModelSection from './AiModelSection'
import VersionSection from './VersionSection'
import BoardsSection from './boards/BoardsSection'
import PlatformWorkspacesSection from './PlatformWorkspacesSection'
import DeploymentBrandCard from './DeploymentBrandCard'
import DataSourcesPage from './DataSourcesPage'
import BrandPage from './BrandPage'
import { DimensionsSection, SourcePoliciesSection } from './DataGovernanceSections'
import { CategoriesSection, ConfigureFirstNotice } from './SettingsSections'
import { SectionAnchor } from './SectionAnchor'
import { usePersonInPath } from './useAdminLocation'
import type { AdminSectionId, AdminTabId } from './adminTabs'

interface ContentProps {
  readonly tab: AdminTabId
  readonly section: AdminSectionId | null
  /** The API endpoint field's value (the dev-only Advanced card edits it). */
  readonly apiEndpoint: string
  readonly onApiEndpointChange: (value: string) => void
  readonly isAdmin: boolean
  readonly isPlatformAdmin: boolean
}

/** People: one table and the person's editor (`/admin/people/<username>`) or the invite (`/admin/people/invite`). */
function PeoplePage({ apiEndpoint }: Readonly<{ apiEndpoint: string }>) {
  const { t } = useTranslation('settings')
  const [item, openItem] = usePersonInPath()
  if (!apiEndpoint) return <ConfigureFirstNotice message={t('users.configureFirst')} />
  return <div className="card"><UserAdmin openItem={item} onOpenItem={openItem} /></div>
}

function CategoriesPage({ apiEndpoint, isAdmin }: Readonly<{ apiEndpoint: string; isAdmin: boolean }>) {
  return (
    <>
      <CategoriesSection apiEndpoint={apiEndpoint} />
      {isAdmin ? <SectionAnchor section="dimensions"><DimensionsSection /></SectionAnchor> : null}
    </>
  )
}

/** Every workspace, then the brand outside them (DeploymentBrandCard.tsx). */
function PlatformPage() {
  return (
    <>
      <PlatformWorkspacesSection />
      <SectionAnchor section="deployment-brand"><DeploymentBrandCard /></SectionAnchor>
    </>
  )
}

/** The admin-only pages; nothing for anyone else. */
function AdminOnlyPage({ tab, apiEndpoint, isPlatformAdmin }: Readonly<Pick<ContentProps, 'tab' | 'apiEndpoint' | 'isPlatformAdmin'>>) {
  switch (tab) {
    case 'people': return <PeoplePage apiEndpoint={apiEndpoint} />
    case 'boards': return apiEndpoint ? <BoardsSection /> : null
    case 'privacy': return <SourcePoliciesSection />
    // The platform console: platform admins only, like its tab (adminTabs.ts).
    case 'platform': return isPlatformAdmin && apiEndpoint ? <PlatformPage /> : null
    case 'version': return <VersionSection />
    default: return null
  }
}

export default function AdminSectionContent(props: ContentProps) {
  const { tab, section, apiEndpoint, onApiEndpointChange, isAdmin, isPlatformAdmin } = props
  switch (tab) {
    case 'sources': return <DataSourcesPage apiEndpoint={apiEndpoint} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} section={section} />
    case 'logs': return <LogsSection apiEndpoint={apiEndpoint} />
    case 'categories': return <CategoriesPage apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
    case 'ai': return <AiModelSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
    case 'brand': return <BrandPage apiEndpoint={apiEndpoint} onApiEndpointChange={onApiEndpointChange} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
    default: return isAdmin ? <AdminOnlyPage tab={tab} apiEndpoint={apiEndpoint} isPlatformAdmin={isPlatformAdmin} /> : null
  }
}
