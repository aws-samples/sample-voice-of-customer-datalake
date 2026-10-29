/**
 * @fileoverview How Data Explorer names a folder.
 *
 * - The bucket's top folders and the source folders (`raw/<source id>`) read by
 *   their label (`Acme (Android)`).
 * - A persona's avatar folder (`avatars/<persona id>`) reads as the persona and when
 *   it was made, "Persona 1 · Oct 24, 2026, 12:34 PM" — the source-label rule turned a
 *   persona id (persona, stamp, hex, index) into "Persona 20261024123456 ab12cd34 0" (5.34.00).
 *   An id without the batch index (an imported persona, `persona_<stamp>_<hex>`, or a
 *   pre-suffix `persona_<stamp>[_<n>]`) reads "Persona · <date>": it was shown raw (5.35.02).
 * - Anything deeper as stored (dates, ids). The stored name stays the row's tooltip.
 *
 * @module pages/DataExplorer/folderLabels
 */
import type { TFunction } from 'i18next'
import { formatDateTime } from '../../utils/dateUtils'

/** `shared/ids.py` `timestamped_id('persona')` plus the persona's index in its batch. */
const PERSONA_ID_RE = /^persona_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[0-9a-f]+_(\d+)$/
/** Any other stamped persona id: imported (`persona_<stamp>_<hex>`) or pre-suffix (`persona_<stamp>[_<n>]`). */
const STAMPED_PERSONA_ID_RE = /^persona_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:_[0-9a-f]+)?$/
const AVATARS_FOLDER = 'avatars'
/** Folders this shallow are the bucket's top folders and the source folders: shown by label. */
const LABELLED_FOLDER_DEPTH = 1

/** The UTC instant a persona id's `YYYYmmddHHMMSS` stamp names, as ISO 8601. */
function stampToIso(parts: readonly string[]): string {
  const [year, month, day, hour, minute, second] = parts
  return `${String(year)}-${String(month)}-${String(day)}T${String(hour)}:${String(minute)}:${String(second)}Z`
}

/** "Persona 1 · Oct 24, 2026, 12:34 PM" (or "Persona · …" without a batch index) for a persona id, else undefined. */
function personaFolderLabel(key: string, language: string, t: TFunction<'dataExplorer'>): string | undefined {
  const match = PERSONA_ID_RE.exec(key)
  if (match !== null) {
    const date = formatDateTime(stampToIso(match.slice(1, 7)), language)
    return t('s3Browser.personaFolder', { n: Number(match[7]) + 1, date })
  }
  const stamped = STAMPED_PERSONA_ID_RE.exec(key)
  if (stamped === null) return undefined
  return t('s3Browser.personaFolderDated', { date: formatDateTime(stampToIso(stamped.slice(1, 7)), language) })
}

interface FolderLabelContext {
  readonly sourceLabel: (id: string) => string
  readonly language: string
  readonly t: TFunction<'dataExplorer'>
}

/** The shown name of folder `key` inside the folder `parent` (the path segments above it). */
export function folderLabel(parent: readonly string[], key: string, context: FolderLabelContext): string {
  if (parent.length === 1 && parent[0] === AVATARS_FOLDER) {
    return personaFolderLabel(key, context.language, context.t) ?? key
  }
  return parent.length <= LABELLED_FOLDER_DEPTH ? context.sourceLabel(key) : key
}
