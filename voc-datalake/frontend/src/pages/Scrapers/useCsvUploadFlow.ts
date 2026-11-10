/**
 * @fileoverview The submit flow of the CSV upload modal.
 *
 * Without a dataset name the upload is one step, as before. With one (issue #411,
 * docs/csv-import.md) it is two: a dry run that answers what the upload would do (new,
 * changed and unchanged rows, and the rows that cannot be updated later), then the upload
 * itself with `apply_updates`, so a stored row is only overwritten after the person has
 * seen the change.
 *
 * @module pages/Scrapers/useCsvUploadFlow
 */
import { useCallback, useState } from 'react'
import { scrapersApi } from '../../api/scrapersApi'
import type { CsvUploadParams } from '../../api/scrapersApi'
import type { CsvDatasetPreview, CsvUploadResult } from '../../api/csvDatasetSchema'

export interface CsvUploadFlow {
  readonly busy: boolean
  readonly preview: CsvDatasetPreview | null
  readonly result: CsvUploadResult | null
  readonly error: string | null
  /** Preview (a dataset upload not previewed yet) or upload; `failed` is the fallback error text. */
  readonly submit: (params: CsvUploadParams, failed: string) => Promise<void>
  /** Leave the preview and edit the choices again. */
  readonly back: () => void
  /** Forget everything (closing, or a new file / setting invalidating the preview). */
  readonly reset: () => void
}

export function useCsvUploadFlow(onImported: (result: CsvUploadResult) => void): CsvUploadFlow {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<CsvDatasetPreview | null>(null)
  const [result, setResult] = useState<CsvUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async (params: CsvUploadParams, failed: string) => {
    setBusy(true); setError(null)
    try {
      if (params.dataset_name !== undefined && preview === null) {
        setPreview(await scrapersApi.previewCsvUpload(params))
        return
      }
      const uploaded = await scrapersApi.uploadCsvFeedback(
        params.dataset_name === undefined ? params : { ...params, apply_updates: true })
      setPreview(null)
      setResult(uploaded)
      onImported(uploaded)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : failed)
    } finally {
      setBusy(false)
    }
  }, [preview, onImported])

  const back = useCallback(() => { setPreview(null); setError(null) }, [])
  const reset = useCallback(() => { setPreview(null); setResult(null); setError(null); setBusy(false) }, [])

  return { busy, preview, result, error, submit, back, reset }
}
