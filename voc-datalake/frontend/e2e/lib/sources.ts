/**
 * The /scrapers "New source" menu (pages/Scrapers/TemplateSelector.tsx +
 * sourceMenu.ts, the 5.x "What do you have?" grouping), shared by modals,
 * writes, s1 and the design overlays.
 *
 * The tiles carry their own words (`scrapers:sourceMenu.items`), not the plugin
 * manifest names, and the technical entries (the CSS-selector scraper, sample
 * data) sit in a collapsed "Advanced" group that must be opened first. The
 * dialog a tile opens keeps its own title: a plugin's is its manifest name, the
 * imports keep "Manual Import" / "JSON Upload" / "CSV upload", a scraper
 * template opens "New Scraper".
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { dialogNamed } from './dialogs'
import { escapeRegExp } from './fixtures'

/** The /scrapers header button (scrapers:newSource). */
export const NEW_SOURCE = 'New source'
/** The menu dialog (scrapers:templateSelector.title). */
export const ADD_SOURCE_DIALOG = 'Add a data source'
/** ScraperEditor.tsx names itself "New Scraper" for every scraper template tile. */
export const SCRAPER_EDITOR = 'New Scraper'

/** English tile title → the accessible name of the dialog it opens. */
export const TILE_DIALOGS: Readonly<Record<string, string>> = {
  'Review page': 'Web Reviews',
  'Custom scraper': SCRAPER_EDITOR,
  'Scraper with CSS selectors': SCRAPER_EDITOR,
  'iPhone app (App Store)': 'iOS App Reviews',
  'Android app (Google Play)': 'Android App Reviews',
  'Spreadsheet (CSV)': 'CSV upload',
  'JSON file': 'JSON Upload',
  'Many files at once (S3)': 'S3 Bulk Import',
  'Paste reviews': 'Manual Import',
  'GitHub Issues': 'GitHub Issues',
  'Sample reviews for demos': 'Synthetic Data Review Generator',
}

/** The tile title of each known plugin id (sourceMenu.ts ENTRY_KEYS, English); others show their manifest name. */
export const PLUGIN_TILE_TITLES: Readonly<Record<string, string>> = {
  web_reviews: 'Review page', app_reviews_ios: 'iPhone app (App Store)', app_reviews_android: 'Android app (Google Play)',
  s3_import: 'Many files at once (S3)', github_issues: 'GitHub Issues', synthetic_reviews: 'Sample reviews for demos',
}

/** Opens the menu's collapsed "Advanced" group, when it has one and it is closed. */
export async function openAdvanced(selector: Locator): Promise<void> {
  const details = selector.locator('details').filter({ has: selector.page().getByText('Advanced', { exact: true }) }).first()
  if (await details.count() === 0) return
  if (await details.getAttribute('open') === null) await details.locator('summary').click()
}

/** Clicks "New source" on the current /scrapers page; returns the open menu with Advanced expanded. */
export async function openSourceMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: NEW_SOURCE, exact: true }).click()
  const selector = dialogNamed(page, ADD_SOURCE_DIALOG)
  await expect(selector).toBeVisible()
  await openAdvanced(selector)
  return selector
}

/** The tile button whose title starts with `title` inside the open menu. */
export const sourceTile = (selector: Locator, title: string): Locator =>
  selector.getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}`) }).first()
