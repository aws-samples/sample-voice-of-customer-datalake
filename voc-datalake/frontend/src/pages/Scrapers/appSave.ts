/**
 * @fileoverview Saving one app connector or review page from its form (`POST /integrations/{source}/apps`), and what
 * the form says when the save fails.
 *
 * A new one (no id yet) is sent as a create (`mode: 'create'`): a page or app the workspace already has is refused
 * (409) instead of being stored a second time, as the API and the assistant already refuse it. An edit stays the
 * upsert it always was. The 409 names the stored source it is about: the one with the same name or the same page
 * (app) (lambda/api/integrations_handler.py `_check_app_write`), found in the list the dialog holds.
 * @module pages/Scrapers/appSave
 */
import { api } from '../../api/client'
import { HTTP_CONFLICT, apiErrorStatus } from '../../api/apiErrorStatus'
import { serverReason } from '../../lib/errors'
import { appCopy } from './appCopy'
import { appField, getAppIdentifier } from './scraper-helpers'
import type { TFunction } from 'i18next'
import type { AppConfig } from './scraper-helpers'

/** A new app or page (no id yet) is a create; an edit the upsert. */
export function saveAppFromForm(pluginId: string, app: AppConfig) {
  return appField(app, 'id') === ''
    ? api.saveAppConfig(pluginId, app, { mode: 'create' })
    : api.saveAppConfig(pluginId, app)
}

/** The server's match: the same text, trimmed and case-folded (an empty one matches nothing). */
function sameStoredText(a: string, b: string): boolean {
  return a.trim() !== '' && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The stored source a refused create of `sent` is about: the same name, or the same page (app). */
function storedTwin(apps: readonly AppConfig[], sent: AppConfig, pluginId: string): AppConfig | undefined {
  return apps.find((app) => sameStoredText(appField(app, 'app_name'), appField(sent, 'app_name'))
    || sameStoredText(getAppIdentifier(app, pluginId), getAppIdentifier(sent, pluginId)))
}

/**
 * What the form says about a failed save of `sent` (null: none failed): a create the server refused as a source it
 * already has ("This page is already a source: Acme"), else the server's own reason, else "Could not save".
 */
export function appSaveMessage(t: TFunction<'scrapers'>, { error, sent, apps, pluginId }: Readonly<{
  error: unknown
  sent: AppConfig | undefined
  apps: readonly AppConfig[]
  pluginId: string
}>): string | null {
  if (error === null || error === undefined) return null
  const created = sent !== undefined && appField(sent, 'id') === ''
  if (created && apiErrorStatus(error) === HTTP_CONFLICT) {
    const twin = storedTwin(apps, sent, pluginId)
    if (twin !== undefined) return t(appCopy(pluginId).alreadySource, { name: appField(twin, 'app_name') })
  }
  return serverReason(error) ?? t('pluginConfig.saveFailed')
}
