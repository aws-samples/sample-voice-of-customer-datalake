/**
 * @fileoverview The unsaved-changes guard's default `shouldBlock`: a navigation
 * that changes the path or the query leaves the editor; a hash-only move does not.
 * @module components/UnsavedChangesGuard/pathOrQueryChanged
 */
import type { Location } from 'react-router-dom'

export const pathOrQueryChanged = (current: Location, next: Location): boolean =>
  current.pathname !== next.pathname || current.search !== next.search
