// Scrapers & Manual Import API - extracted from client.ts for code splitting
import { del, post } from './requestKit'
import { fetchApi } from './client'
import { runAssistJob } from './assistJobs'
import { parseSelectorAnalysis } from './assistResults'
import { parseCsvDatasetPreview, parseCsvUploadResult } from './csvDatasetSchema'
import type { CsvDatasetPreview, CsvUploadResult } from './csvDatasetSchema'
import { normalizeScrapers, normalizeScraperRunStatus } from './scrapersSchema'
import type { ScraperRunStatus } from './scrapersSchema'
import type {
  CsvColumnTarget, ScraperConfig, ScraperTemplate,
} from './types'

export const scrapersApi = {
  // ScraperConfig declares its fields required, but runtime payloads have
  // delivered sparse records (issues #167/#169). Normalize on entry so the
  // declared contract is true for every consumer.
  getScrapers: async (): Promise<{ scrapers: ScraperConfig[] }> => {
    const response = await fetchApi<{ scrapers?: unknown[] }>('/scrapers')
    return { scrapers: normalizeScrapers(response.scrapers ?? []) }
  },

  getScraperTemplates: () => fetchApi<{ templates: ScraperTemplate[] }>('/scrapers/templates'),

  saveScraper: (scraper: ScraperConfig) =>
    fetchApi<{
      success: boolean;
      scraper: ScraperConfig
    }>('/scrapers', post({ scraper })),

  deleteScraper: (id: string) =>
    fetchApi<{ success: boolean }>(`/scrapers/${id}`, del()),

  // An assist job (api/assistJobs): 202 + poll GET /scrapers/jobs/{id}, whose
  // `result` is the body this route used to answer synchronously.
  analyzeUrlForSelectors: (url: string) => runAssistJob(
    () => fetchApi<unknown>('/scrapers/analyze-url', post({ url })),
    (jobId) => fetchApi<unknown>(`/scrapers/jobs/${encodeURIComponent(jobId)}`),
    parseSelectorAnalysis,
  ),

  runScraper: (id: string) =>
    fetchApi<{
      success: boolean;
      execution_id: string;
      status: string
    }>(`/scrapers/${id}/run`, post()),

  // The status endpoint's runtime shape has drifted from the declared one
  // (issue #169: undefined counts rendered 'Last: pages, reviews' blank).
  // Normalize on entry: counts degrade to 0, errors to [].
  getScraperStatus: async (id: string): Promise<ScraperRunStatus> => {
    const response = await fetchApi<unknown>(`/scrapers/${id}/status`)
    return normalizeScraperRunStatus(response)
  },

  // Manual Import (shares /scrapers/ route prefix)
  startManualImportParse: (sourceUrl: string, rawText: string) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      source_origin?: string;
      message?: string;
      error?: string
    }>('/scrapers/manual/parse', post({
        source_url: sourceUrl,
        raw_text: rawText,
      })),

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
        /** True when the text had no date and `date` is the import date (manual_import_processor.py). */
        date_defaulted?: boolean;
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
    }>('/scrapers/manual/confirm', post({
        job_id: jobId,
        reviews,
      })),

  /**
   * `radarBrand`: a Radar brand key; the items then go to Radar only (docs/radar.md).
   * `assistant`: set by the assistant's `import_reviews`, so the import history names the
   * method and the source the user gave (docs/import-history.md).
   */
  uploadJsonFeedback: (items: Array<Record<string, unknown>>, sourceId?: string, radarBrand?: string,
    assistant?: { sourceLabel: string }) =>
    fetchApi<{
      success: boolean;
      imported_count: number;
      total_items: number;
      s3_uri?: string;
      errors?: string[]
    }>('/scrapers/manual/json-upload', post({
        items,
        ...(sourceId === undefined ? {} : { source_id: sourceId }),
        ...(radarBrand === undefined ? {} : { radar_brand: radarBrand }),
        ...(assistant === undefined ? {} : { import_origin: 'assistant', source_label: assistant.sourceLabel }),
      })),
  /**
   * `source_id`: the source profile the rows belong to (default `manual_import`);
   * `column_map`: `{<csv header>: <target>}` (see `CsvColumnTarget`). Headers not
   * mapped and not auto-detected server-side land in `metadata`.
   */
  uploadCsvFeedback: async (params: CsvUploadParams & {
    /** Confirms the updates a dataset preview listed (409 without it when stored rows change). */
    apply_updates?: boolean
  }): Promise<CsvUploadResult> =>
    parseCsvUploadResult(await fetchApi<unknown>('/scrapers/manual/csv-upload', post(params))),

  /** What a CSV upload would do (`dry_run`): new / changed / unchanged / not-updatable rows. Nothing is stored. */
  previewCsvUpload: async (params: CsvUploadParams): Promise<CsvDatasetPreview> =>
    parseCsvDatasetPreview(await fetchApi<unknown>('/scrapers/manual/csv-upload', post({ ...params, dry_run: true }))),
}

/** The body of a CSV upload (and of its preview). */
export interface CsvUploadParams {
  csv_text: string
  default_source?: string
  source_id?: string
  column_map?: Record<string, CsvColumnTarget>
  /** A Radar brand key: the rows go to Radar only (docs/radar.md). Not with `dataset_name`. */
  radar_brand?: string
  /** The dataset a corrected re-upload updates (rows with an `id` only; docs/csv-import.md). */
  dataset_name?: string
}
