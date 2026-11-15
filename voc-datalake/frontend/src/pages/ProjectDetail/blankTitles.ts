/**
 * @fileoverview The names a blank document starts with, and the names it may not take.
 *
 * A Documents section's New and a PRD / PR/FAQ section's "Blank" open an empty canvas under a predefined name
 * ("Untitled document", "Untitled PRD"); when the project already has one by that name, the first free
 * "Untitled document 2", "… 3". A PRD / PR/FAQ's name is its series (generatedDocTitle.ts `documentSeriesKey`, the
 * server's `normalized_base_title`): filed under the name of a series the project has, the blank template would
 * become the next version of that document, so such a name is refused before anything is written.
 *
 * @module pages/ProjectDetail/blankTitles
 */
import { isVersionManagedDocument } from '../../api/documentLineage'
import { documentSeriesKey } from './generatedDocTitle'
import { seriesKeyOf } from './documentEdit'
import type { GatedDocType } from '../../api/aiModeApi'
import type { ProjectDocument } from '../../api/types'

/** What a blank New makes: a custom document, or a PR/FAQ / PRD written by hand. */
export type BlankDocumentType = 'custom' | GatedDocType

/** How many numbered names are tried before the base name with the next number is taken as is. */
const MAX_TRIES = 1000

/** A custom document's name as people read it: NFKC, one space between words, any case. */
function plainKey(title: string): string {
  return title.normalize('NFKC').split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

/**
 * Whether `title` is taken for a new document of `type`: by another research / custom document's title (a custom
 * document), or by a series of that type (a PRD / PR/FAQ, whose name would join it).
 */
export function isTitleTaken(type: BlankDocumentType, title: string, documents: readonly ProjectDocument[]): boolean {
  if (type === 'custom') {
    const key = plainKey(title)
    return documents.some((document) => !isVersionManagedDocument(document) && plainKey(document.title) === key)
  }
  const key = documentSeriesKey(title, type)
  return documents.some((document) => document.document_type === type && seriesKeyOf(document) === key)
}

/**
 * `base` when it is free for `type`, else the first free `numbered(n)` from 2 ("Untitled document 2").
 * `numbered` is the translated pattern, so the number sits where the language puts it.
 */
export function firstFreeTitle(
  type: BlankDocumentType, base: string, numbered: (n: number) => string, documents: readonly ProjectDocument[],
): string {
  if (!isTitleTaken(type, base, documents)) return base
  const from = (n: number): string => (n > MAX_TRIES || !isTitleTaken(type, numbered(n), documents) ? numbered(n) : from(n + 1))
  return from(2)
}
