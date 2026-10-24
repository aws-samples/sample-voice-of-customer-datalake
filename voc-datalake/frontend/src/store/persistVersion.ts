import type { z } from 'zod'

/**
 * The persisted-store version every Zustand `persist` store declares (issue #267 item 9).
 *
 * Version 1 is the FIRST versioned shape and is identical to what these stores
 * already wrote without a version — Zustand records those blobs as version 0. A
 * store with no `version` and no `migrate` has no upgrade path: a future change
 * of its shape would load old blobs as-is, and a version bump without a
 * `migrate` makes Zustand discard them. A store whose persisted shape changes
 * passes its own `version` and an `upgrade` that rewrites the older blob.
 */
const PERSISTED_STORE_VERSION = 1

/** A store-specific version bump: the new version and how an older blob is rewritten to it. */
interface PersistUpgrade {
  readonly version: number
  /** Rewrite a blob stored at `fromVersion` (< `version`) into the current shape, before validation. */
  readonly upgrade: (persisted: unknown, fromVersion: number) => unknown
}

/**
 * The `version` + `migrate` pair for a store whose persisted shape is `schema`.
 *
 * Every earlier version is upgraded by `options.upgrade` when given (else kept
 * as-is) — and then validated, never trusted: localStorage is writable by
 * anything on the origin and outlives deploys. A blob that does not match loads
 * as `{}`, i.e. the store's defaults, rather than crashing a page on a missing
 * field.
 */
export function versionedPersist<Schema extends z.ZodType>(schema: Schema, options?: PersistUpgrade) {
  return {
    version: options?.version ?? PERSISTED_STORE_VERSION,
    migrate: (persisted: unknown, fromVersion: number): Partial<z.infer<Schema>> => {
      const upgraded = options ? options.upgrade(persisted, fromVersion) : persisted
      const parsed = schema.safeParse(upgraded)
      return parsed.success ? parsed.data : {}
    },
  }
}
