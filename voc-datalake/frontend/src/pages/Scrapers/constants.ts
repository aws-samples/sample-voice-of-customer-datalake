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
 *
 * NOT routed through i18n, and that is a decision rather than an oversight — but a
 * weak one, recorded so the next reader does not have to guess. `GeneratorConfigModal`
 * carried this exact literal before it was consolidated here, so the constant
 * inherits the omission rather than introducing it, and consolidating first means
 * translating it later is a one-line change at a single definition site. The rest of
 * this page IS translated (`PluginConfigModal` has three `useTranslation` calls), so
 * the inconsistency is real: a non-English user gets this one tooltip in English.
 *
 * `frontend/scripts/i18n-check.mjs` cannot catch it either way, so nothing will
 * prompt the fix. Its heuristic reports a DIRECTORY in which no file calls
 * `useTranslation` at all — and `Scrapers/` is mixed, so `AppConfigComponents.tsx`
 * (zero calls) is invisible because the directory as a whole is exempt.
 *
 * Every assertion on this string imports the constant instead of restating it, so
 * translating it is a change to this file alone and does not fail a test whose
 * subject is the admin gate.
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
