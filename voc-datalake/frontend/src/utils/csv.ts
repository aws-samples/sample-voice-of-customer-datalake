/**
 * @fileoverview CSV field encoding for client-side exports.
 * @module utils/csv
 */

/**
 * Quotes a CSV field: doubles embedded quotes and neutralizes spreadsheet
 * formula injection (a leading =, +, -, @, tab, or CR in untrusted feedback
 * text would otherwise be executed by Excel when the export is opened).
 */
export function csvField(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? '' : String(value)
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${guarded.replace(/"/g, '""')}"`
}
