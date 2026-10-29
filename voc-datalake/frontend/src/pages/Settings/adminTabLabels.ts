/**
 * @fileoverview Labels and icons of the Administration tabs and sections
 * (`settings:tabs.*`, `settings:sections.*`) for the caller's visible set.
 * @module pages/Settings/adminTabLabels
 */
import {
  Building2, Cpu, FileWarning, Info, KeyRound, Layers, Lightbulb, Mail, Plug, Radar, Server, ShieldCheck, Tags, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { visibleSections, visibleTabs } from './adminTabs'
import type { AdminSectionId, AdminTabId } from './adminTabs'
import type { SectionItem as LabelledItem } from './SectionSwitch'

const TAB_ICONS: Readonly<Record<AdminTabId, LucideIcon>> = {
  brand: Building2, sources: Plug, taxonomy: Tags, access: ShieldCheck, ai: Cpu, system: Server,
}

const SECTION_ICONS: Readonly<Record<AdminSectionId, LucideIcon>> = {
  plugins: Plug, integrations: KeyRound, inbox: Mail, radar: Radar,
  categories: Tags, dimensions: Layers,
  policies: ShieldCheck, users: Users, boards: Lightbulb,
  logs: FileWarning, version: Info,
}

/** `brand` keeps its pre-5.09 label key, `general`. */
const tabLabelKey = (id: AdminTabId): string => (id === 'brand' ? 'tabs.general' : `tabs.${id}`)

/** The id of a section's tab button in the section switch; its panel is labelled by it. */
export const sectionTabId = (id: string): string => `admin-section-tab-${id}`
export const SECTION_PANEL_ID = 'admin-section-panel'

type Translate = (key: string) => string

export function buildTabs(t: Translate, isAdmin: boolean): LabelledItem<AdminTabId>[] {
  return visibleTabs(isAdmin).map((id) => ({ id, label: t(tabLabelKey(id)), icon: TAB_ICONS[id] }))
}

export function buildSections(t: Translate, tab: AdminTabId, isAdmin: boolean): LabelledItem<AdminSectionId>[] {
  return visibleSections(tab, isAdmin).map((id) => ({ id, label: t(`sections.${id}`), icon: SECTION_ICONS[id] }))
}
