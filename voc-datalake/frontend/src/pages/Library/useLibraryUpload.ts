/**
 * @fileoverview The upload sheet's files and their uploads. Each chosen file is checked first (libraryFormats.ts:
 * its type and size, as the API checks them), starts from details its name gives (a title; the short name the
 * server makes from it), and uploads in three steps, one file after another: `create` (a pending item and its
 * presigned PUT), the PUT with its progress, then `markUploaded`, which starts the reading.
 *
 * A file that fails after its item was made takes the item back with it (a best-effort delete: the uploader may
 * always delete their own), so trying again makes one item, never a second pending one; its short name is free
 * again too.
 *
 * @module pages/Library/useLibraryUpload
 */
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { libraryApi, libraryKeys, putLibraryFile } from '../../api/libraryApi'
import type { LibraryCreateBody } from '../../api/libraryApi'
import { checkFile, isSlug, parseTags, tagsProblem, titleFromFilename } from './libraryFormats'
import type { FileCheck } from './libraryFormats'
import { libraryFailure } from './libraryErrors'
import type { LibraryFailure } from './libraryErrors'

export interface DraftFields {
  readonly title: string
  readonly slug: string
  readonly source: string
  readonly docDate: string
  readonly tags: string
}

type UploadPhase = 'ready' | 'creating' | 'uploading' | 'finishing' | 'done' | 'failed'

export interface UploadEntry {
  readonly key: string
  readonly file: File
  readonly check: FileCheck
  readonly fields: DraftFields
  readonly phase: UploadPhase
  /** The PUT's progress, 0 to 1. */
  readonly progress: number
  readonly failure: LibraryFailure | null
}

/** What is wrong with a file's details before it is sent, or null. */
export type FieldProblem = 'titleRequired' | 'badSlug' | 'tooManyTags' | 'tagTooLong'

export function fieldProblem(fields: DraftFields): FieldProblem | null {
  if (fields.title.trim() === '') return 'titleRequired'
  if (fields.slug.trim() !== '' && !isSlug(fields.slug.trim())) return 'badSlug'
  const tags = tagsProblem(parseTags(fields.tags))
  if (tags === 'tooMany') return 'tooManyTags'
  return tags === 'tooLong' ? 'tagTooLong' : null
}

const isSendable = (entry: UploadEntry): boolean =>
  entry.check.ok && (entry.phase === 'ready' || entry.phase === 'failed') && fieldProblem(entry.fields) === null

function createBody(entry: UploadEntry, contentType: string): LibraryCreateBody {
  const { title, slug, source, docDate, tags } = entry.fields
  return {
    filename: entry.file.name, content_type: contentType, bytes: entry.file.size, title: title.trim(),
    ...(slug.trim() === '' ? {} : { slug: slug.trim() }),
    ...(source.trim() === '' ? {} : { source: source.trim() }),
    ...(docDate === '' ? {} : { doc_date: docDate }),
    ...(tags.trim() === '' ? {} : { tags: parseTags(tags) }),
  }
}

/** Take back the pending item of a failed upload; a refusal leaves it for the person to delete. */
function discardPending(itemId: string): void {
  libraryApi.remove(itemId).catch((error: unknown) => { console.error('Failed to remove a pending library item', error) })
}

type Report = (patch: Partial<Pick<UploadEntry, 'phase' | 'progress' | 'failure'>>) => void

async function send(entry: UploadEntry, contentType: string, report: Report): Promise<void> {
  report({ phase: 'creating', progress: 0, failure: null })
  const created = await libraryApi.create(createBody(entry, contentType))
  try {
    report({ phase: 'uploading' })
    await putLibraryFile(created.upload, entry.file, (progress) => report({ progress }))
    report({ phase: 'finishing', progress: 1 })
    await libraryApi.markUploaded(created.item.item_id)
  } catch (error) {
    discardPending(created.item.item_id)
    throw error
  }
  report({ phase: 'done' })
}

const NEXT_KEY = { value: 0 }

function newEntry(file: File): UploadEntry {
  NEXT_KEY.value += 1
  return {
    key: `upload-${String(NEXT_KEY.value)}`, file, check: checkFile(file),
    fields: { title: titleFromFilename(file.name), slug: '', source: '', docDate: '', tags: '' },
    phase: 'ready', progress: 0, failure: null,
  }
}

export function useLibraryUpload() {
  const queryClient = useQueryClient()
  const [entries, setEntries] = useState<readonly UploadEntry[]>([])
  const [running, setRunning] = useState(false)

  const patch = useCallback((key: string, change: Partial<UploadEntry>) => {
    setEntries((current) => current.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)))
  }, [])
  const add = useCallback((files: readonly File[]) => {
    setEntries((current) => [...current, ...files.map(newEntry)])
  }, [])
  const remove = useCallback((key: string) => {
    setEntries((current) => current.filter((entry) => entry.key !== key))
  }, [])
  const setFields = useCallback((key: string, fields: DraftFields) => patch(key, { fields }), [patch])

  const start = useCallback(async () => {
    setRunning(true)
    for (const entry of entries.filter(isSendable)) {
      const contentType = entry.check.ok ? entry.check.contentType : ''
      try {
        await send(entry, contentType, (change) => patch(entry.key, change))
      } catch (error) {
        patch(entry.key, { phase: 'failed', failure: libraryFailure(error) })
      }
      await queryClient.invalidateQueries({ queryKey: libraryKeys.all })
    }
    setRunning(false)
  }, [entries, patch, queryClient])

  const sendable = entries.filter(isSendable).length
  const reset = useCallback(() => setEntries([]), [])
  return { entries, add, remove, setFields, start, running, sendable, reset }
}
