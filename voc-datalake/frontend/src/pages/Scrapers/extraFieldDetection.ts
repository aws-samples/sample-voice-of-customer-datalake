/**
 * @fileoverview Detect the field names in a large import file without reading
 * the whole thing into memory (Phase 5).
 *
 * The large-file path deliberately streams the bytes straight to S3 and never
 * parses them in the browser (that is the whole reason it exists — a 75 MB file
 * would be hostile to a FileReader). But the mapping screen needs to know the
 * file's columns to offer a per-row "source" field. So this reads only a HEAD
 * SLICE (the first chunk) and extracts the keys of the first record it finds,
 * handling both a JSON array and JSONL. It is best-effort: a file whose first
 * record is past the slice, or malformed, yields an empty list, and the mapping
 * step simply offers no suggestions rather than failing the upload.
 *
 * @module pages/Scrapers/extraFieldDetection
 */

/** How much of the file head to read when sniffing field names (256 KB). */
export const FIELD_SNIFF_BYTES = 256 * 1024

/** Result of sniffing a file's fields. */
export interface DetectedFields {
  /** Top-level keys of the first record found, in first-seen order. Empty when none could be read. */
  readonly fields: string[]
}

/**
 * Extract the top-level keys of the first JSON object in a text slice.
 *
 * Accepts the two shapes the ingestor accepts: a JSON array/`{items:[...]}`
 * wrapper, or JSONL (one object per line). Parsing the WHOLE slice as JSON
 * fails for a truncated array, so this isolates the first `{...}` object and
 * parses only that — which works whether the slice holds one line of JSONL or
 * the opening of a large array.
 */
export function extractFieldsFromText(text: string): string[] {
  const firstObject = sliceFirstJsonObject(text)
  if (firstObject === null) return []
  return objectKeys(firstObject)
}

/** Parse a JSON object string and return its keys; [] for anything not a plain object. */
function objectKeys(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    // After this guard, `parsed` narrows to `object`, which Object.keys accepts
    // directly — no type assertion needed.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed)
    }
  } catch {
    // Truncated or malformed head — offer no suggestions rather than throw.
  }
  return []
}

/** Running state of the brace scanner, threaded immutably through a reduce. */
interface ScanState {
  readonly depth: number
  readonly inString: boolean
  readonly escaped: boolean
  readonly end: number | null
}

/** Advance the scanner by one character. Once `end` is set it stays set. */
function scanChar(state: ScanState, ch: string, index: number): ScanState {
  if (state.end !== null) return state
  if (state.inString) {
    if (state.escaped) return { ...state, escaped: false }
    if (ch === '\\') return { ...state, escaped: true }
    if (ch === '"') return { ...state, inString: false }
    return state
  }
  if (ch === '"') return { ...state, inString: true }
  if (ch === '{') return { ...state, depth: state.depth + 1 }
  if (ch === '}') {
    const depth = state.depth - 1
    return { ...state, depth, end: depth === 0 ? index : null }
  }
  return state
}

/**
 * Return the substring spanning the first balanced top-level `{...}`.
 *
 * Brace-counts so a nested object inside the first record doesn't end it early,
 * and tracks string state so a `}` inside a string value is not miscounted.
 * Returns null when no complete object is present in the slice.
 */
function sliceFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  const initial: ScanState = { depth: 0, inString: false, escaped: false, end: null }
  const final = [...text.slice(start)].reduce<ScanState>(
    (state, ch, offset) => scanChar(state, ch, offset),
    initial,
  )
  return final.end === null ? null : text.slice(start, start + final.end + 1)
}

/**
 * Read the head of a file and detect its record fields.
 *
 * Only {@link FIELD_SNIFF_BYTES} are read via `Blob.slice`, so this stays cheap
 * on a multi-hundred-MB file. Never throws: an unreadable head resolves to an
 * empty field list.
 */
export async function detectFileFields(file: File): Promise<DetectedFields> {
  try {
    const head = file.slice(0, FIELD_SNIFF_BYTES)
    const text = await head.text()
    return { fields: extractFieldsFromText(text) }
  } catch {
    return { fields: [] }
  }
}
