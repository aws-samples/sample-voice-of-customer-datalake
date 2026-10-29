/**
 * @fileoverview The content of every Administration tab but General (whose
 * brand form state lives in Settings itself), per tab and section. Admin-only
 * sections render nothing for anyone else, even when a deep link names them.
 * @module pages/Settings/AdminSectionContent
 */
import LogsSection from './LogsSection'
import AiModelSection from './AiModelSection'
import IntegrationsSection from './IntegrationsSection'
import VersionSection from './VersionSection'
import RadarSection from './RadarSection'
import EmailInboxCard from './EmailInboxCard'
import ParticipantSettingsCard from './ParticipantSettingsCard'
import BoardsSection from './boards/BoardsSection'
import { DimensionsSection, SourcePoliciesSection } from './DataGovernanceSections'
import { CategoriesSection, DataSourcesSection, UserAdminSection } from './SettingsSections'
import type { AdminSectionId, AdminTabId } from './adminTabs'

interface ContentProps {
  readonly apiEndpoint: string
  readonly isAdmin: boolean
}

/** The admin-only sections; nothing for anyone else. */
function AdminOnlySection({ section, apiEndpoint }: Readonly<{ section: AdminSectionId; apiEndpoint: string }>) {
  switch (section) {
    case 'integrations': return <IntegrationsSection />
    case 'inbox': return <EmailInboxCard />
    case 'radar': return <RadarSection />
    case 'dimensions': return <DimensionsSection />
    case 'policies': return <SourcePoliciesSection />
    // The engagement settings sit with the users: they decide who counts as a colleague.
    case 'users': return (
      <div className="space-y-6">
        <UserAdminSection apiEndpoint={apiEndpoint} />
        {apiEndpoint ? <ParticipantSettingsCard /> : null}
      </div>
    )
    case 'boards': return apiEndpoint ? <BoardsSection /> : null
    case 'version': return <VersionSection />
    default: return null
  }
}

function SectionContent({ section, apiEndpoint, isAdmin }: Readonly<ContentProps & { section: AdminSectionId }>) {
  switch (section) {
    case 'plugins': return <DataSourcesSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
    case 'categories': return <CategoriesSection apiEndpoint={apiEndpoint} />
    case 'logs': return <LogsSection apiEndpoint={apiEndpoint} />
    default: return isAdmin ? <AdminOnlySection section={section} apiEndpoint={apiEndpoint} /> : null
  }
}

export default function AdminSectionContent({ tab, section, apiEndpoint, isAdmin }: Readonly<ContentProps & {
  tab: AdminTabId
  section: AdminSectionId | null
}>) {
  if (tab === 'ai') return <AiModelSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
  if (section === null) return null
  return <SectionContent section={section} apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
}
