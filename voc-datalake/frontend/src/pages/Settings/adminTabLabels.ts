/**
 * @fileoverview Labels and icons of the Administration tabs, sections and cards (`settings:tabs.*`,
 * `settings:sections.*`, `settings:tabHints.*`), spelled out so the i18n audit sees every key, and the ids the tab
 * row, the section switch and the cards' anchors share.
 * @module pages/Settings/adminTabLabels
 */
import {
  Bot, Building2, CircleDollarSign, Cpu, FileWarning, FolderCog, Info, KeyRound, Layers, Lightbulb, Mail, Palette, Plug, Radar, Server,
  ShieldCheck, Tags, Users, UsersRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AdminCardId, AdminSectionId, AdminTabId } from './adminTabs'

export const TAB_ICONS: Readonly<Record<AdminTabId, LucideIcon>> = {
  general: Building2, sources: Plug, taxonomy: Tags, access: ShieldCheck, ai: Cpu, workspaces: FolderCog, agents: Bot,
  system: Server,
}

export const SECTION_ICONS: Readonly<Record<AdminSectionId, LucideIcon>> = {
  plugins: Plug, integrations: KeyRound, inbox: Mail, radar: Radar,
  categories: Tags, dimensions: Layers,
  policies: ShieldCheck, users: Users, boards: Lightbulb,
  settings: FolderCog, members: UsersRound, all: Building2, costs: CircleDollarSign, 'deployment-brand': Palette,
  logs: FileWarning, version: Info,
}

const TAB_LABEL_KEYS: Readonly<Record<AdminTabId, string>> = {
  general: 'tabs.general', sources: 'tabs.sources', taxonomy: 'tabs.taxonomy', access: 'tabs.access', ai: 'tabs.ai',
  workspaces: 'tabs.workspaces', agents: 'tabs.agents', system: 'tabs.system',
}

const TAB_HINT_KEYS: Readonly<Record<AdminTabId, string>> = {
  general: 'tabHints.general', sources: 'tabHints.sources', taxonomy: 'tabHints.taxonomy', access: 'tabHints.access',
  ai: 'tabHints.ai', workspaces: 'tabHints.workspaces', agents: 'tabHints.agents', system: 'tabHints.system',
}

const SECTION_LABEL_KEYS: Readonly<Record<AdminSectionId, string>> = {
  plugins: 'sections.plugins', integrations: 'sections.integrations', inbox: 'sections.inbox', radar: 'sections.radar',
  categories: 'sections.categories', dimensions: 'sections.dimensions',
  policies: 'sections.policies', users: 'sections.users', boards: 'sections.boards',
  settings: 'sections.workspace', members: 'sections.members', all: 'sections.allWorkspaces',
  costs: 'sections.costs', 'deployment-brand': 'sections.deploymentBrand',
  logs: 'sections.logs', version: 'sections.version',
}

const CARD_LABEL_KEYS: Readonly<Record<AdminCardId, string>> = {
  brand: 'sections.brand', theme: 'sections.theme', 'app-feedback': 'sections.appFeedback', api: 'sections.api',
  erasure: 'sections.erasure',
  domains: 'sections.domains', participants: 'sections.participants', 'hard-cap': 'sections.hardCap',
  models: 'sections.models', connections: 'sections.connections',
}

/** A tab's label key (`settings:tabs.*`). */
export const tabLabelKey = (id: AdminTabId): string => TAB_LABEL_KEYS[id]

/** A tab's one line (`settings:tabHints.*`): under the tab row, what the tab is for. */
export const tabHintKey = (id: AdminTabId): string => TAB_HINT_KEYS[id]

/** A section's label key (`settings:sections.*`). */
export const sectionLabelKey = (id: AdminSectionId): string => SECTION_LABEL_KEYS[id]

/** A card's label key (`settings:sections.*`). */
export const cardLabelKey = (id: AdminCardId): string => CARD_LABEL_KEYS[id]

/** The id of a tab's button in the tab row; the tab's panel is labelled by it. */
export const tabButtonId = (id: AdminTabId): string => `admin-tab-${id}`
export const TAB_PANEL_ID = 'admin-tab-panel'

/** The id of a section's button in the section switch; the section's panel is labelled by it. */
export const sectionTabId = (id: AdminSectionId): string => `admin-section-tab-${id}`
export const SECTION_PANEL_ID = 'admin-section-panel'

/** The id of a card's anchor: an address naming the card (`#theme`) scrolls it into view and focuses it. */
export const cardAnchorId = (id: AdminCardId): string => `admin-card-${id}`
