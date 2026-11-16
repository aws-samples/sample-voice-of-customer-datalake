/**
 * @fileoverview Memory's tabs as paths (7.49.00, utils/tabPaths.ts): `/memory/company` (`/memory` too),
 * `/memory/personal`, and the curators' `/memory/review` and `/memory/imports`. Which tabs a person may open is the
 * page's (Memory.tsx): a curator tab for anyone else shows Company.
 *
 * @module pages/Memory/memoryPaths
 */
import type { TabPage } from '../../utils/tabPaths'

const MEMORY_TABS = ['company', 'personal', 'review', 'imports'] as const
export type MemoryTab = typeof MEMORY_TABS[number]

export const MEMORY_PAGE: TabPage<MemoryTab> = { base: '/memory', tabs: MEMORY_TABS }
