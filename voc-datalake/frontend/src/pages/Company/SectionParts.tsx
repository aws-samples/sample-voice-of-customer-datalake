/**
 * @fileoverview The query-and-draft wiring the editable Company sections share:
 * render a section's body once its query has loaded (with the shared loading /
 * failed state before that), and the save row bound to a save mutation and a
 * `useDraft` draft.
 *
 * @module pages/Company/SectionParts
 */
import type { ReactNode } from 'react'
import { QueryState, SaveRow } from './ContextParts'

interface SectionQuery<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
  refetch: () => Promise<unknown>
}

/** The section's load/error state, then `children(data)` once the query has data. */
export function LoadedSection<T>({ query, children }: Readonly<{
  query: SectionQuery<T>
  children: (data: T) => ReactNode
}>) {
  return (
    <>
      <QueryState isLoading={query.isLoading} isError={query.isError} onRetry={() => void query.refetch()} />
      {query.data ? children(query.data) : null}
    </>
  )
}

/** The save row of a draft-backed section: enabled only while the draft is dirty (and valid). */
export function DraftSaveRow({ save, dirty, onSave, invalid = false }: Readonly<{
  save: { isPending: boolean; isSuccess: boolean; isError: boolean }
  dirty: boolean
  onSave: () => void
  invalid?: boolean
}>) {
  return (
    <SaveRow
      onSave={onSave}
      pending={save.isPending}
      saved={save.isSuccess && !dirty}
      failed={save.isError}
      disabled={!dirty || invalid}
    />
  )
}
