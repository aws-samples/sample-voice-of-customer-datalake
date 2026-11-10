/**
 * @fileoverview Scraper constants.
 * @module pages/Scrapers/constants
 */

import type { ScraperConfig } from '../../api/types'

/** The schedules a scraper offers, in minutes (0 = manual only); labels come from `getFrequencyLabel`. */
export const FREQUENCY_OPTIONS = [0, 15, 30, 60, 180, 360, 720, 1440] as const

export const DEFAULT_SCRAPER: Omit<ScraperConfig, 'id'> = {
  name: 'New Scraper',
  enabled: true,
  base_url: '',
  urls: [],
  // Manual only: a new scraper does not run until someone schedules it
  // (the industry default; it used to start daily runs on first save).
  frequency_minutes: 0,
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
