/**
 * Plugin names and descriptions are translated (5.35.03, e2e 5.35.02: in Spanish,
 * Administration → Sources still read "Android App Reviews … Collect customer reviews from
 * the Google Play Store", "S3 Bulk Import", "Web Scraper": the cards showed the English
 * manifest text).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import i18n from 'i18next'
import { renderWithQueryClient } from '../test/query-client'
import SourceCard from '../pages/Settings/SourceCard'
import manifests from './manifests.json'
import esSettings from '../../public/locales/es/settings.json'
import { pluginCopyKeys } from './pluginCopy'
import { supportedLanguages } from '../i18n/languages'
import type { PluginManifest } from './types'

vi.mock('../api/client', () => ({
  api: {
    getIntegrationStatus: () => Promise.resolve({}),
    getSourcesStatus: () => Promise.resolve({ sources: {} }),
    enableSource: vi.fn(),
    disableSource: vi.fn(),
  },
}))

const LOCALES = import.meta.glob<Record<string, unknown>>('../../public/locales/*/settings.json', { eager: true, import: 'default' })

function valueAt(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), tree)
}

const ANDROID: PluginManifest = {
  id: 'app_reviews_android', name: 'Android App Reviews', icon: 'Android', enabled: true,
  description: 'Collect customer reviews from the Google Play Store', config: [],
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false,
}

describe('plugin copy', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each(manifests.map((manifest) => manifest.id))('%s has a translated name and description in every locale', (id) => {
    const keys = pluginCopyKeys(id)
    expect(keys).toBeDefined()
    const missing = supportedLanguages.flatMap((lang) => [keys?.nameKey, keys?.descriptionKey].filter((key) => {
      const value = valueAt(LOCALES[`../../public/locales/${lang}/settings.json`], (key ?? '').replace('settings:', ''))
      return typeof value !== 'string' || value.trim() === ''
    }).map((key) => `${lang}:${key ?? ''}`))
    expect(missing).toStrictEqual([])
  })

  it('shows the Administration source card in the UI language', async () => {
    i18n.addResourceBundle('es', 'settings', esSettings, true, true)
    await i18n.changeLanguage('es')
    renderWithQueryClient(<SourceCard manifest={ANDROID} apiEndpoint="https://api.example.com" isAdmin />)
    expect(screen.getByText('Reseñas de apps Android')).toBeInTheDocument()
    expect(screen.getByText('Recopila reseñas de clientes de Google Play Store')).toBeInTheDocument()
    expect(screen.queryByText('Android App Reviews')).not.toBeInTheDocument()
  })

  it('falls back to the manifest text for a plugin without keys', () => {
    renderWithQueryClient(<SourceCard manifest={{ ...ANDROID, id: 'new_plugin', name: 'New Plugin' }} apiEndpoint="" isAdmin />)
    expect(screen.getByText('New Plugin')).toBeInTheDocument()
  })
})
