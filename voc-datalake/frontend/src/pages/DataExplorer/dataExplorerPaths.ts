/**
 * @fileoverview The Data Explorer's two tabs as paths (7.49.00, utils/tabPaths.ts): `/data-explorer/raw`
 * (`/data-explorer` too), the S3 raw data, and `/data-explorer/processed`, the processed feedback.
 *
 * @module pages/DataExplorer/dataExplorerPaths
 */
import type { TabPage } from '../../utils/tabPaths'

const DATA_EXPLORER_TABS = ['raw', 'processed'] as const
type DataExplorerTab = typeof DATA_EXPLORER_TABS[number]

export const DATA_EXPLORER_PAGE: TabPage<DataExplorerTab> = { base: '/data-explorer', tabs: DATA_EXPLORER_TABS }
