// Scrapers & Manual Import API - extracted from client.ts for code splitting
import { fetchApi } from './client'
import type {
  ScraperConfig, ScraperTemplate,
} from './types'

// What /scrapers actually returns: base_url is declared required on
// ScraperConfig, but runtime payloads have delivered scrapers without it
// (issue #167). Model that honestly here and normalize on entry so the
// declared contract is true for every consumer.
type RawScraperConfig = Omit<ScraperConfig, 'base_url'> & { base_url?: string }

export const scrapersApi = {
  getScrapers: async (): Promise<{ scrapers: ScraperConfig[] }> => {
    const response = await fetchApi<{ scrapers: RawScraperConfig[] }>('/scrapers')
    return {
      scrapers: (response.scrapers ?? []).map((scraper) => ({
        ...scraper,
        base_url: typeof scraper.base_url === 'string' ? scraper.base_url : '',
      })),
    }
  },

  getScraperTemplates: () => fetchApi<{ templates: ScraperTemplate[] }>('/scrapers/templates'),

  saveScraper: (scraper: ScraperConfig) =>
    fetchApi<{
      success: boolean;
      scraper: ScraperConfig
    }>('/scrapers', {
      method: 'POST',
      body: JSON.stringify({ scraper }),
    }),

  deleteScraper: (id: string) =>
    fetchApi<{ success: boolean }>(`/scrapers/${id}`, { method: 'DELETE' }),

  analyzeUrlForSelectors: (url: string) =>
    fetchApi<{
      success: boolean
      selectors?: {
        container_selector: string
        text_selector: string
        rating_selector?: string
        rating_attribute?: string
        author_selector?: string
        date_selector?: string
        title_selector?: string
        confidence: string
        detected_reviews_count: number
        notes?: string
        warnings?: string[]
      }
      message?: string
      error?: string
    }>('/scrapers/analyze-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  runScraper: (id: string) =>
    fetchApi<{
      success: boolean;
      execution_id: string;
      status: string
    }>(`/scrapers/${id}/run`, { method: 'POST' }),

  getScraperStatus: (id: string) =>
    fetchApi<{
      scraper_id: string
      execution_id?: string
      status: string
      started_at?: string
      completed_at?: string
      pages_scraped: number
      items_found: number
      errors: string[]
    }>(`/scrapers/${id}/status`),

  getScraperRuns: (id: string) =>
    fetchApi<{
      runs: Array<{
        sk: string;
        status: string;
        started_at: string;
        completed_at?: string;
        pages_scraped: number;
        items_found: number
      }>
    }>(`/scrapers/${id}/runs`),

  // Manual Import (shares /scrapers/ route prefix)
  startManualImportParse: (sourceUrl: string, rawText: string) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      source_origin?: string;
      message?: string;
      error?: string
    }>('/scrapers/manual/parse', {
      method: 'POST',
      body: JSON.stringify({
        source_url: sourceUrl,
        raw_text: rawText,
      }),
    }),

  getManualImportStatus: (jobId: string) =>
    fetchApi<{
      status: 'processing' | 'completed' | 'failed' | 'not_found'
      source_origin?: string
      source_url?: string
      reviews?: Array<{
        text: string;
        rating: number | null;
        author: string | null;
        date: string | null;
        title: string | null
      }>
      unparsed_sections?: string[]
      error?: string
    }>(`/scrapers/manual/parse/${jobId}`),

  confirmManualImport: (jobId: string, reviews: Array<{
    text: string;
    rating: number | null;
    author: string | null;
    date: string | null;
    title: string | null
  }>) =>
    fetchApi<{
      success: boolean;
      imported_count?: number;
      s3_uri?: string;
      message?: string;
      error?: string;
      errors?: string[]
    }>('/scrapers/manual/confirm', {
      method: 'POST',
      body: JSON.stringify({
        job_id: jobId,
        reviews,
      }),
    }),

  uploadJsonFeedback: (items: Array<Record<string, unknown>>) =>
    fetchApi<{
      success: boolean;
      imported_count: number;
      total_items: number;
      s3_uri?: string;
      errors?: string[]
    }>('/scrapers/manual/json-upload', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  uploadCsvFeedback: (params: { csv_text: string; default_source?: string }) =>
    fetchApi<{
      success: boolean;
      imported_count: number;
      total_rows: number;
      s3_uri?: string;
      warnings?: string[];
      errors?: string[]
    }>('/scrapers/manual/csv-upload', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
}
