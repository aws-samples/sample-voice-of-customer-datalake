/**
 * @fileoverview The imports this browser submitted, newest first.
 *
 * The memory API has `POST /memory/imports` and `GET /memory/imports/{id}` but
 * no list route, so the Imports tab remembers the ids it created (localStorage,
 * Zod-validated on read, capped) and polls each one's status. Clearing site data
 * only forgets the list here; the imports and their memories are unaffected.
 *
 * @module pages/Memory/importHistory
 */
import { isNonEmptyString, lenientList } from '../../api/lenientFields'

const STORAGE_KEY = 'voc-memory-imports'
const MAX_REMEMBERED = 20

const HistorySchema = lenientList(isNonEmptyString)

export function readImportHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? [] : HistorySchema.parse(JSON.parse(raw))
  } catch {
    return []
  }
}

export function rememberImport(importId: string): string[] {
  const next = [importId, ...readImportHistory().filter((id) => id !== importId)].slice(0, MAX_REMEMBERED)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage full or disabled: the list stays in memory for this session.
  }
  return next
}
