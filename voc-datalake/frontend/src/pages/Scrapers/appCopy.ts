/**
 * @fileoverview The words the plugin dialog uses for one configured item. App-review
 * connectors configure *apps*; Web Reviews configures *review pages* (a Trustpilot
 * company page, a product's reviews page), so "Configured Apps / Add App" was wrong there.
 * @module pages/Scrapers/appCopy
 */
import { Globe, Smartphone } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { WEB_REVIEWS_PLUGIN_ID } from './scraper-helpers'

/** `scrapers` namespace keys, plus the empty-state icon. */
export interface AppCopy {
  readonly list: string
  readonly add: string
  readonly addNew: string
  readonly edit: string
  readonly empty: string
  readonly addFirst: string
  readonly unnamed: string
  readonly deleteTitle: string
  readonly deleteMessage: string
  readonly icon: LucideIcon
}

const APP_COPY: AppCopy = {
  list: 'appCard.configuredApps',
  add: 'appCard.addApp',
  addNew: 'appCard.addNewApp',
  edit: 'appCard.editApp',
  empty: 'appCard.noApps',
  addFirst: 'appCard.addFirstApp',
  unnamed: 'appCard.unnamed',
  deleteTitle: 'appCard.deleteConfirmTitle',
  deleteMessage: 'appCard.deleteConfirmMessage',
  icon: Smartphone,
}

const WEB_PAGE_COPY: AppCopy = {
  list: 'appCard.web.configuredPages',
  add: 'appCard.web.addPage',
  addNew: 'appCard.web.addNewPage',
  edit: 'appCard.web.editPage',
  empty: 'appCard.web.noPages',
  addFirst: 'appCard.web.addFirstPage',
  unnamed: 'appCard.web.unnamed',
  deleteTitle: 'appCard.web.deleteConfirmTitle',
  deleteMessage: 'appCard.web.deleteConfirmMessage',
  icon: Globe,
}

export function appCopy(pluginId: string): AppCopy {
  return pluginId === WEB_REVIEWS_PLUGIN_ID ? WEB_PAGE_COPY : APP_COPY
}
