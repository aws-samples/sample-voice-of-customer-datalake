/**
 * @fileoverview Scraper constants.
 * @module pages/Scrapers/constants
 */

import type { ScraperConfig } from '../../api/client'

export const FREQUENCY_OPTIONS = [
  { value: 0, label: 'Manual only' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 180, label: 'Every 3 hours' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Daily' },
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
  pagination: { enabled: false, param: 'page', max_pages: 5, start: 1 },
}
