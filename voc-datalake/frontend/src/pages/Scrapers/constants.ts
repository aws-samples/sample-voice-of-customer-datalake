/**
 * @fileoverview Scraper constants.
 * @module pages/Scrapers/constants
 */

import type { ScraperConfig } from '../../api/types'

/**
 * The `title` on every control this page disables because the route behind it is
 * admin-gated server-side.
 *
 * Declared once, and here rather than in either component, because THREE files
 * render such a control — `AppConfigComponents` (Run, Delete),
 * `PluginConfigModal` (Add, Save, Delete, Run, the schedule toggle) and
 * `GeneratorConfigModal` (Generate, which is where this wording came from). A
 * per-file literal is how one of them ends up saying something different from the
 * others about the same 403.
 *
 * The routes: `POST`/`DELETE /integrations/{source}/apps`,
 * `POST /sources/{source}/run` and `PUT /sources/{source}/enable|disable`. These
 * were NOT gated — a `users`-group caller could write the shared secret and invoke
 * an ingestor — so the gate is the server's and this is only the explanation.
 */
export const ADMIN_ONLY_TITLE = 'Admin access required'

export const FREQUENCY_OPTIONS = [
  {
    value: 0,
    label: 'Manual only',
  },
  {
    value: 15,
    label: 'Every 15 minutes',
  },
  {
    value: 30,
    label: 'Every 30 minutes',
  },
  {
    value: 60,
    label: 'Every hour',
  },
  {
    value: 180,
    label: 'Every 3 hours',
  },
  {
    value: 360,
    label: 'Every 6 hours',
  },
  {
    value: 720,
    label: 'Every 12 hours',
  },
  {
    value: 1440,
    label: 'Daily',
  },
] as const

export const DEFAULT_SCRAPER: Omit<ScraperConfig, 'id'> = {
  name: 'New Scraper',
  enabled: true,
  base_url: '',
  urls: [],
  frequency_minutes: 1440,
  extraction_method: 'css',
  container_selector: '.review',
  text_selector: '.review-text',
  title_selector: '',
  rating_selector: '',
  date_selector: '',
  author_selector: '',
  link_selector: 'a',
  pagination: {
    enabled: false,
    param: 'page',
    max_pages: 5,
    start: 1,
  },
}
