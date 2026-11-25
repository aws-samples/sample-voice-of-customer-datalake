/**
 * @fileoverview The Library list's filters as the page holds them (the toolbar's controls), and a project the
 * filter and the editor offer.
 *
 * @module pages/Library/libraryFilters
 */
import type { LibrarySort } from '../../api/libraryApi'

export interface LibraryFilters {
  readonly search: string
  readonly tag: string
  readonly projectId: string
  readonly sort: LibrarySort
}

export const DEFAULT_FILTERS: LibraryFilters = { search: '', tag: '', projectId: '', sort: 'newest' }

export interface ProjectOption {
  readonly id: string
  readonly name: string
}
