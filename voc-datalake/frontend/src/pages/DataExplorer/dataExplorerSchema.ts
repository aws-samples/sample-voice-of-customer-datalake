/**
 * @fileoverview Lenient wire-boundary normalizers for the Data Explorer's
 * bucket list and S3 listing.
 *
 * The declared types in api/client.ts describe the Lambda's shape
 * (`{ id, name, label }` buckets; `{ objects: [...] }` listings), but nothing
 * guarantees a response matches them — the mock server historically served
 * `{ name, region }` buckets (no `id`, which produced React key warnings and a
 * blank bucket picker) and a `{ folders, files }` listing. Each record is
 * normalized on its own, so one malformed entry is dropped instead of blanking
 * the whole view.
 * @module pages/DataExplorer/dataExplorerSchema
 */

import { z } from 'zod'

export interface BucketOption {
  readonly id: string
  readonly label: string
}

interface S3ListingObject {
  readonly key: string
  readonly fullKey?: string
  readonly size: number
  readonly lastModified: string
  readonly isFolder: boolean
}

export interface S3Listing {
  readonly objects: S3ListingObject[]
  readonly bucket: string
  readonly prefix: string
}

const optionalString = z.string().optional().catch(undefined)

const bucketSchema = z.object({
  id: optionalString,
  name: optionalString,
  label: optionalString,
})

const nonEmpty = (...values: Array<string | undefined>): string | undefined =>
  values.find((v) => v != null && v !== '')

/** Normalize `GET /data-explorer/buckets`; entries with neither id nor name are dropped. */
export function normalizeBuckets(raw: unknown): BucketOption[] {
  const list = z.object({ buckets: z.array(z.unknown()) }).safeParse(raw)
  if (!list.success) return []
  const seen = new Set<string>()
  return list.data.buckets.flatMap((entry) => {
    const parsed = bucketSchema.safeParse(entry)
    if (!parsed.success) return []
    const id = nonEmpty(parsed.data.id, parsed.data.name)
    if (id == null || seen.has(id)) return []
    seen.add(id)
    return [{ id, label: nonEmpty(parsed.data.label, parsed.data.name, id) ?? id }]
  })
}

const objectSchema = z.object({
  key: z.string().min(1),
  fullKey: optionalString,
  size: z.number().catch(0),
  lastModified: z.string().catch(''),
  isFolder: z.boolean().catch(false),
})

const legacyFileSchema = z.object({
  key: z.string().min(1),
  size: z.number().catch(0),
  last_modified: z.string().catch(''),
})

const listingSchema = z.object({
  objects: z.array(z.unknown()).optional().catch(undefined),
  folders: z.array(z.unknown()).optional().catch(undefined),
  files: z.array(z.unknown()).optional().catch(undefined),
  bucket: optionalString,
  prefix: optionalString,
})

/** Last path segment of an S3 key or folder prefix (`a/b/` → `b`). */
function baseName(key: string): string {
  return key.split('/').filter((part) => part !== '').pop() ?? ''
}

function legacyObjects(folders: unknown[], files: unknown[]): S3ListingObject[] {
  const folderObjects = folders.flatMap((f): S3ListingObject[] =>
    typeof f === 'string' && baseName(f) !== ''
      ? [{ key: baseName(f), size: 0, lastModified: '', isFolder: true }]
      : [])
  const fileObjects = files.flatMap((f): S3ListingObject[] => {
    const parsed = legacyFileSchema.safeParse(f)
    if (!parsed.success) return []
    return [{
      key: baseName(parsed.data.key),
      fullKey: parsed.data.key,
      size: parsed.data.size,
      lastModified: parsed.data.last_modified,
      isFolder: false,
    }]
  })
  return [...folderObjects, ...fileObjects]
}

/** Normalize `GET /data-explorer/s3`, or undefined when there is no response yet. */
export function normalizeS3Listing(raw: unknown): S3Listing | undefined {
  if (raw === undefined) return undefined
  const parsed = listingSchema.safeParse(raw)
  if (!parsed.success) return { objects: [], bucket: '', prefix: '' }
  const { objects, folders, files, bucket, prefix } = parsed.data
  const normalized = objects == null
    ? legacyObjects(folders ?? [], files ?? [])
    : objects.flatMap((o) => {
      const r = objectSchema.safeParse(o)
      return r.success ? [r.data] : []
    })
  return { objects: normalized, bucket: bucket ?? '', prefix: prefix ?? '' }
}
