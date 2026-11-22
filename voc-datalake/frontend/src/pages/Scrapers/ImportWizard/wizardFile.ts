/**
 * @fileoverview The file the import wizard reads (7.67.00, docs/import-wizard.md): its format, the sample the
 * server's detection reads (at most 256 KB, cut at a line end), and its rows as `{header: text}` with the headers
 * named exactly as the server names them (lambda/shared/import_detect.py `_headers`: trimmed, a blank one
 * `Column n`, a repeated one `Name (n)`), so a mapping the detection answered fits the rows sent.
 *
 * A text file is read as UTF-8, else as Windows-1252 with a warning. CSV and TSV are parsed here (RFC 4180 quoting, a
 * byte-order mark dropped) with the separator the detection found;
 * JSON (an array of objects, an object holding one, or one object per line) as the server reads it; a workbook's rows
 * come back from the detection (the browser cannot read an XLSX). Pure but for `readWizardFile`.
 *
 * @module pages/Scrapers/ImportWizard/wizardFile
 */
import type { ColumnKind, FileFormat } from '../../../api/importWizardSchema'
import { isRecord } from '../../../lib/typeGuards'

export const SAMPLE_BYTES = 256 * 1024
/** A reviews file's ceiling (the CSV import's 10 MB), a survey export's (sent whole on the first import call, so its
 * request stays inside Lambda's 6 MB payload: 2 MB). */
const MAX_REVIEWS_BYTES = 10 * 1024 * 1024
export const MAX_SURVEY_BYTES = 2 * 1024 * 1024
const MAX_COLUMNS = 200
const MAX_HEADER_CHARS = 256
const MAX_VALUES_PER_COLUMN = 500
const MAX_VALUE_CHARS = 1000
const MAX_VALUE_COLUMNS = 50
const VALUE_KINDS: ReadonlySet<ColumnKind> = new Set(['choice', 'multi_choice', 'matrix_cell'])

export interface WizardFile {
  readonly name: string
  readonly format: FileFormat
  readonly size: number
  /** The text of a CSV, TSV or JSON file; the base64 of a workbook. */
  readonly content: string
  /** A text file that was not UTF-8, read as Windows-1252 (the Upload step says so). */
  readonly legacyEncoding: boolean
}

export interface Table {
  readonly headers: readonly string[]
  readonly rows: readonly Readonly<Record<string, string>>[]
}

export type FilePickProblem = 'format' | 'tooLarge' | 'workbookTooLarge' | 'empty' | 'unreadable'

const EXTENSIONS: Readonly<Record<string, FileFormat>> = {
  csv: 'csv', txt: 'csv', tsv: 'tsv', tab: 'tsv', json: 'json', jsonl: 'json', ndjson: 'json', xlsx: 'xlsx',
}

/** The format of a file by its extension, or null for one the wizard does not read. */
export function formatOf(name: string): FileFormat | null {
  const extension = name.toLowerCase().split('.').pop() ?? ''
  return EXTENSIONS[extension] ?? null
}

/** Why a picked file cannot be read, or null. */
export function pickProblem(file: { readonly name: string; readonly size: number }): FilePickProblem | null {
  const format = formatOf(file.name)
  if (format === null) return 'format'
  if (file.size === 0) return 'empty'
  if (format === 'xlsx' && file.size > SAMPLE_BYTES) return 'workbookTooLarge'
  return file.size > MAX_REVIEWS_BYTES ? 'tooLarge' : null
}

const BASE64_CHUNK = 0x8000

function base64Of(bytes: Uint8Array): string {
  const parts = Array.from({ length: Math.ceil(bytes.length / BASE64_CHUNK) }, (_unused, index) =>
    String.fromCharCode(...bytes.subarray(index * BASE64_CHUNK, (index + 1) * BASE64_CHUNK)))
  return btoa(parts.join(''))
}

/** A text file's characters: UTF-8 (its byte-order mark dropped) when the bytes are UTF-8, else Windows-1252, which
 * older spreadsheet tools write a CSV in (`legacyEncoding`: never replacement characters in silence). */
function decodeText(bytes: Uint8Array): { readonly text: string; readonly legacyEncoding: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), legacyEncoding: false }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), legacyEncoding: true }
  }
}

/** The picked file read once: its text, or a workbook's base64. */
export async function readWizardFile(file: File): Promise<WizardFile> {
  const format = formatOf(file.name) ?? 'csv'
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (format === 'xlsx') return { name: file.name, format, size: file.size, content: base64Of(bytes), legacyEncoding: false }
  const { text, legacyEncoding } = decodeText(bytes)
  return { name: file.name, format, size: file.size, content: text, legacyEncoding }
}

/** The first 256 KB of a text, cut after its last whole line; `truncated` when that is not the whole text. */
export function textSample(text: string): { sample: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= SAMPLE_BYTES) return { sample: text, truncated: false }
  const head = new TextDecoder().decode(bytes.subarray(0, SAMPLE_BYTES))
  const end = head.lastIndexOf('\n')
  return { sample: end > 0 ? head.slice(0, end + 1) : head, truncated: true }
}

/** The detection's sample of `file`: a text's first 256 KB, a JSON file's first records that fit, a workbook whole. */
export function sampleOf(file: WizardFile): { sample: string; truncated: boolean } {
  if (file.format !== 'json') return file.format === 'xlsx' ? { sample: file.content, truncated: false } : textSample(file.content)
  const encoder = new TextEncoder()
  if (encoder.encode(file.content).length <= SAMPLE_BYTES) return { sample: file.content, truncated: false }
  const records = jsonRecords(file.content)
  // `[` and `]`, then each record and its comma, while they fit.
  const fitting = records.reduce<{ bytes: number; count: number; full: boolean }>((acc, record) => {
    const bytes = acc.bytes + encoder.encode(JSON.stringify(record)).length + 1
    return acc.full || bytes > SAMPLE_BYTES ? { ...acc, full: true } : { bytes, count: acc.count + 1, full: false }
  }, { bytes: 2, count: 0, full: false })
  return { sample: JSON.stringify(records.slice(0, fitting.count)), truncated: true }
}

/** One cell and what ends it (the separator, a line end or the end), quoted (a doubled quote is a quote) or bare. */
function cellPattern(delimiter: string): RegExp {
  const separator = delimiter === '|' ? '\\|' : delimiter.replaceAll('\t', '\\t')
  return new RegExp(`(?:"([^"]*(?:""[^"]*)*)"|([^${separator}\\r\\n]*))(${separator}|\\r\\n|\\n|\\r|$)`, 'gu')
}

/** The records of a delimited text: RFC 4180 quoting, any line end, blank lines out, a byte-order mark dropped. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const records: string[][] = [[]]
  for (const match of text.replace(/^\uFEFF/u, '').matchAll(cellPattern(delimiter))) {
    if (match[0] === '') break
    const [, quoted, bare = '', end] = match
    records.at(-1)?.push(quoted === undefined ? bare : quoted.replaceAll('""', '"'))
    if (end !== delimiter) records.push([])
  }
  return records.filter((record) => record.some((value) => value.trim() !== ''))
}

/** The header row as the server names it. */
export function headersOf(raw: readonly unknown[]): string[] {
  const headers: string[] = []
  raw.slice(0, MAX_COLUMNS).forEach((name, index) => {
    const text = cellText(name).slice(0, MAX_HEADER_CHARS)
    const named = text === '' ? `Column ${index + 1}` : text
    headers.push(headers.includes(named) ? `${named} (${index + 1})` : named)
  })
  return headers
}

function rowsOf(headers: readonly string[], records: readonly (readonly string[])[]): Record<string, string>[] {
  return records.map((record) => Object.fromEntries(headers.map((header, i) => [header, (record[i] ?? '').trim()])))
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== '').map(cellText).join('; ')
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' ? value.trim() : ''
}

/** The whole text as one JSON value, or `undefined` when it is not one (one object per line, JSON Lines). */
function wholeJson(body: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(body) }
  } catch {
    return undefined
  }
}

function jsonRecords(text: string): unknown[] {
  const body = text.replace(/^\uFEFF/u, '').trim()
  const whole = wholeJson(body)
  if (whole === undefined) return body.split(/\r?\n/u).filter((line) => line.trim() !== '').map((line): unknown => JSON.parse(line))
  const parsed = whole.value
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed === 'object' && parsed !== null) {
    const lists = Object.values(parsed).filter((value): value is unknown[] => Array.isArray(value))
    const [only] = lists
    return lists.length === 1 && only !== undefined ? only : [parsed]
  }
  return []
}

function jsonTable(text: string): Table {
  const records = jsonRecords(text).filter(isRecord)
  const names: string[] = []
  for (const record of records) for (const key of Object.keys(record)) if (!names.includes(key)) names.push(key)
  const kept = names.slice(0, MAX_COLUMNS)
  const headers = headersOf(kept)
  return { headers, rows: records.map((record) => Object.fromEntries(headers.map((header, i) => [header, cellText(record[kept[i] ?? ''])]))) }
}

/** Every row of `file`: a text parsed with `delimiter`, a JSON file read, a workbook's rows as the detection sent them. */
export function tableOf(file: WizardFile, delimiter: string, workbook?: { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] }): Table {
  if (file.format === 'xlsx') return { headers: workbook?.headers ?? [], rows: rowsOf(workbook?.headers ?? [], workbook?.rows ?? []) }
  if (file.format === 'json') return jsonTable(file.content)
  const [header = [], ...records] = parseDelimited(file.content, delimiter)
  const headers = headersOf(header)
  return { headers, rows: rowsOf(headers, records) }
}

/** The distinct cells of every choice, multiple-choice and matrix column over the whole file (the detection's
 * `values`: the inferred options are the file's, not only the sample's), bounded as the server bounds them. */
export function distinctValues(table: Table, kinds: Readonly<Record<string, ColumnKind>>): Record<string, string[]> {
  const headers = table.headers.filter((header) => VALUE_KINDS.has(kinds[header] ?? 'ignore')).slice(0, MAX_VALUE_COLUMNS)
  return Object.fromEntries(headers.map((header) => [header, distinctOf(table.rows, header)]))
}

/** One column's distinct cells (the first spelling of each, ignoring case), bounded. */
function distinctOf(rows: Table['rows'], header: string): string[] {
  const seen = new Map<string, string>()
  for (const row of rows) {
    const value = (row[header] ?? '').trim()
    const folded = value.toLowerCase()
    if (value !== '' && value.length <= MAX_VALUE_CHARS && seen.size < MAX_VALUES_PER_COLUMN && !seen.has(folded)) {
      seen.set(folded, value)
    }
  }
  return [...seen.values()]
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** A table as comma-separated text (a JSON file's or a workbook's rows for the CSV import). */
export function toCsv(table: Table): string {
  const lines = [table.headers.map(csvCell).join(','),
    ...table.rows.map((row) => table.headers.map((header) => csvCell(row[header] ?? '')).join(','))]
  return `${lines.join('\n')}\n`
}
