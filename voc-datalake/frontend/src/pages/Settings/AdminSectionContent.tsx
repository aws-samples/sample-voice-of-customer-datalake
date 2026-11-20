/**
 * @fileoverview What each Administration tab and section shows (7.59.00, adminTabs.ts): a tab without sections is
 * one page (General, AI models, Engineering agents), a tab with sections shows the open one. An admin-only section
 * renders nothing for anyone else, even when a link names it (adminTabs.ts already sends such a link elsewhere).
 * @module pages/Settings/AdminSectionContent
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import UserAdmin from '../../components/UserAdmin/UserAdmin'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { SectionHeader } from '../Company/ContextParts'
import { WorkspaceMembers } from '../Members/Members'
import { WorkspaceSettingsCards } from '../WorkspaceSettings/WorkspaceSettings'
import LogsSection from './LogsSection'
import AiModelSection from './AiModelSection'
import VersionSection from './VersionSection'
import BoardsSection from './boards/BoardsSection'
import PlatformWorkspacesSection from './PlatformWorkspacesSection'
import DeploymentBrandCard from './DeploymentBrandCard'
import DataSourcesPage from './DataSourcesPage'
import EmailInboxCard from './EmailInboxCard'
import IntegrationsSection from './IntegrationsSection'
import RadarSection from './RadarSection'
import GeneralTab from './GeneralTab'
import EngineeringAgentsTab from './EngineeringAgentsTab'
import { DimensionsSection, SourcePoliciesSection } from './DataGovernanceSections'
import { CategoriesSection, ConfigureFirstNotice } from './SettingsSections'
import { usePersonInPath } from './useAdminLocation'
import type { AdminPlace } from './adminPaths'
import { visibleSections } from './adminTabs'
import type { AdminSectionId, AdminTabId, AdminViewer } from './adminTabs'

interface ContentProps {
  readonly place: AdminPlace
  readonly viewer: AdminViewer
  /** The API endpoint field's value (the dev-only card on General edits it). */
  readonly apiEndpoint: string
  readonly onApiEndpointChange: (value: string) => void
}

/** Users (main's name; 7.54.00's People): one table and a person's editor or the invite, the item of the path. */
function UsersSection({ apiEndpoint }: Readonly<{ apiEndpoint: string }>) {
  const { t } = useTranslation('settings')
  const [item, openItem] = usePersonInPath()
  return (
    <section className="card">
      <SectionHeader icon={Users} title={t('users.title')} description={t('users.description')} />
      {apiEndpoint
        ? <UserAdmin openItem={item} onOpenItem={openItem} />
        : <ConfigureFirstNotice message={t('users.configureFirst')} />}
    </section>
  )
}

/** Workspaces' sections about the workspace the app is in: none outside one. */
function CurrentWorkspaceSection({ section }: Readonly<{ section: 'settings' | 'members' }>) {
  const workspace = useCurrentWorkspace()
  if (workspace === null) return null
  return section === 'settings' ? <WorkspaceSettingsCards workspace={workspace} /> : <WorkspaceMembers workspace={workspace} />
}

interface SectionProps {
  readonly apiEndpoint: string
  readonly viewer: AdminViewer
}

/** What each section shows (SectionContent renders one only for a viewer who may see it). */
const SECTIONS: Readonly<Record<AdminSectionId, (props: SectionProps) => ReactNode>> = {
  plugins: ({ apiEndpoint, viewer }) => <DataSourcesPage apiEndpoint={apiEndpoint} isAdmin={viewer.isAdmin} isPlatformAdmin={viewer.isPlatformAdmin} />,
  integrations: () => <IntegrationsSection />,
  inbox: () => <EmailInboxCard />,
  radar: () => <RadarSection />,
  categories: ({ apiEndpoint }) => <CategoriesSection apiEndpoint={apiEndpoint} />,
  dimensions: () => <DimensionsSection />,
  policies: () => <SourcePoliciesSection />,
  users: ({ apiEndpoint }) => <UsersSection apiEndpoint={apiEndpoint} />,
  boards: ({ apiEndpoint }) => (apiEndpoint ? <BoardsSection /> : null),
  settings: () => <CurrentWorkspaceSection section="settings" />,
  members: () => <CurrentWorkspaceSection section="members" />,
  // The platform console: platform admins only, like its sections (adminTabs.ts).
  all: ({ apiEndpoint, viewer }) => (viewer.isPlatformAdmin && apiEndpoint ? <PlatformWorkspacesSection /> : null),
  'deployment-brand': ({ apiEndpoint, viewer }) => (viewer.isPlatformAdmin && apiEndpoint ? <DeploymentBrandCard /> : null),
  logs: ({ apiEndpoint }) => <LogsSection apiEndpoint={apiEndpoint} />,
  version: () => <VersionSection />,
}

/** The section, for a viewer who may see it on this tab (adminTabs.ts): a hidden one renders nothing, even from a link. */
function SectionContent({ tab, section, apiEndpoint, viewer }: Readonly<SectionProps & { tab: AdminTabId; section: AdminSectionId }>) {
  if (!visibleSections(tab, viewer).includes(section)) return null
  const View = SECTIONS[section]
  return <View apiEndpoint={apiEndpoint} viewer={viewer} />
}

export default function AdminSectionContent({ place, viewer, apiEndpoint, onApiEndpointChange }: ContentProps) {
  switch (place.tab) {
    case 'general': return <GeneralTab apiEndpoint={apiEndpoint} onApiEndpointChange={onApiEndpointChange} isAdmin={viewer.isAdmin}
      isPlatformAdmin={viewer.isPlatformAdmin} />
    case 'ai': return <AiModelSection apiEndpoint={apiEndpoint} isAdmin={viewer.isAdmin} />
    case 'agents': return viewer.isAdmin ? <EngineeringAgentsTab /> : null
    default: return place.section === null
      ? null
      : <SectionContent tab={place.tab} section={place.section} apiEndpoint={apiEndpoint} viewer={viewer} />
  }
}
