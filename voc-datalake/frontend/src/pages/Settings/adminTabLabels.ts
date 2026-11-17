/**
 * @fileoverview Labels of the Administration tabs, groups and sections, and the tabs' icons (`settings:tabs.*`,
 * `settings:home.groups.*`, `settings:sections.*`, `settings:home.jobs.<tab>.hint`), spelled out so the i18n audit
 * sees every key.
 * @module pages/Settings/adminTabLabels
 */
import { Building2, Cpu, FileWarning, History, Lightbulb, Palette, Plug, ShieldCheck, Tags, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AdminGroupId, AdminSectionId, AdminTabId } from './adminTabs'

export const TAB_ICONS: Readonly<Record<AdminTabId, LucideIcon>> = {
  people: Users, sources: Plug, logs: FileWarning, categories: Tags, boards: Lightbulb, ai: Cpu, brand: Palette,
  privacy: ShieldCheck, platform: Building2, version: History,
}

const TAB_LABEL_KEYS: Readonly<Record<AdminTabId, string>> = {
  people: 'tabs.people', sources: 'tabs.sources', logs: 'tabs.logs', categories: 'tabs.categories', boards: 'tabs.boards',
  ai: 'tabs.ai', brand: 'tabs.brand', privacy: 'tabs.privacy', platform: 'tabs.platform', version: 'tabs.version',
}

const TAB_HINT_KEYS: Readonly<Record<AdminTabId, string>> = {
  people: 'home.jobs.people.hint', sources: 'home.jobs.sources.hint', logs: 'home.jobs.logs.hint',
  categories: 'home.jobs.categories.hint', boards: 'home.jobs.boards.hint', ai: 'home.jobs.ai.hint',
  brand: 'home.jobs.brand.hint', privacy: 'home.jobs.privacy.hint', platform: 'home.jobs.platform.hint',
  version: 'home.jobs.version.hint',
}

const GROUP_LABEL_KEYS: Readonly<Record<AdminGroupId, string>> = {
  everyday: 'home.groups.everyday', regular: 'home.groups.regular', once: 'home.groups.once', rare: 'home.groups.rare',
}

const SECTION_LABEL_KEYS: Readonly<Record<AdminSectionId, string>> = {
  inbox: 'sections.inbox', radar: 'sections.radar', tokens: 'sections.tokens', dimensions: 'sections.dimensions',
  domains: 'sections.domains', participants: 'sections.participants', theme: 'sections.theme',
  erasure: 'sections.erasure', 'deployment-brand': 'sections.deploymentBrand',
}

/** A tab's label key (`settings:tabs.*`). */
export const tabLabelKey = (id: AdminTabId): string => TAB_LABEL_KEYS[id]

/** A tab's one-line job (`settings:home.jobs.<tab>.hint`): under its title on the home and on its page. */
export const tabHintKey = (id: AdminTabId): string => TAB_HINT_KEYS[id]

/** A group's heading key (`settings:home.groups.*`). */
export const groupLabelKey = (id: AdminGroupId): string => GROUP_LABEL_KEYS[id]

/** A section's label key (`settings:sections.*`). */
export const sectionLabelKey = (id: AdminSectionId): string => SECTION_LABEL_KEYS[id]

/** The id of a section's card on its tab's page: a path naming the section scrolls it into view and focuses it. */
export const sectionAnchorId = (id: AdminSectionId): string => `admin-section-${id}`
