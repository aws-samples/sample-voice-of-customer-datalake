/**
 * @fileoverview Shared file utility functions.
 * @module utils/file
 */
import { formatCount, formatDecimal } from './numberFormat'

export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^a-z0-9]/gi, '_')
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const KIB = 1024
const MIB = KIB * KIB

/** A byte count as "512 B", "2.0 KB" or "1.5 MB", with the locale's grouping and decimal mark (pl "1,5 MB"). */
export function formatFileSize(bytes: number, locale: string): string {
  if (bytes < KIB) return `${formatCount(bytes, locale)} B`
  if (bytes < MIB) return `${formatDecimal(bytes / KIB, locale, 1)} KB`
  return `${formatDecimal(bytes / MIB, locale, 1)} MB`
}
