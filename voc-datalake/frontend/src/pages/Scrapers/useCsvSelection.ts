/**
 * @fileoverview The chosen CSV file of the upload modal: size/type checks, its
 * text (read once), and the column mapping suggested from its header row.
 *
 * @module pages/Scrapers/useCsvSelection
 */
import { useCallback, useState } from 'react'
import { parseCsvHeader, suggestMapping } from './csvColumns'
import type { Dimension } from '../../api/dimensionsSchema'
import type { CsvColumnTarget } from '../../api/types'

const MAX_BYTES = 10 * 1024 * 1024

export type CsvPickError = 'tooLarge' | 'notCsv' | 'noHeader' | 'unreadable'

export interface CsvSelection {
  file: File
  text: string
  mapping: Record<string, CsvColumnTarget>
}

function pickError(file: File): CsvPickError | null {
  if (file.size > MAX_BYTES) return 'tooLarge'
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return 'notCsv'
  return null
}

export function useCsvSelection(dimensions: readonly Dimension[]) {
  const [selection, setSelection] = useState<CsvSelection | null>(null)
  const [error, setError] = useState<CsvPickError | null>(null)

  const pick = useCallback(async (file: File | null) => {
    setError(null)
    setSelection(null)
    if (file === null) return
    const refused = pickError(file)
    if (refused !== null) {
      setError(refused)
      return
    }
    try {
      const text = await file.text()
      const headers = parseCsvHeader(text)
      if (headers.length === 0) {
        setError('noHeader')
        return
      }
      setSelection({ file, text, mapping: suggestMapping(headers, dimensions) })
    } catch {
      setError('unreadable')
    }
  }, [dimensions])

  const setMapping = useCallback((mapping: Record<string, CsvColumnTarget>) => {
    setSelection((current) => (current === null ? null : { ...current, mapping }))
  }, [])

  const reset = useCallback(() => {
    setSelection(null)
    setError(null)
  }, [])

  return { selection, error, pick, setMapping, reset }
}
