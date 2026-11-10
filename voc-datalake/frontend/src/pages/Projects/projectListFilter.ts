/**
 * @fileoverview What the Projects list shows: a text search over name and
 * description, whose projects ("Mine" = the caller owns it; "Shared with me" =
 * any other project the caller can see), and the order (recently updated first,
 * or by name).
 *
 * @module pages/Projects/projectListFilter
 */
import type { Project } from '../../api/projectTypes'

export const PROJECT_SCOPES = ['all', 'mine', 'shared'] as const
export type ProjectScope = (typeof PROJECT_SCOPES)[number]

export const PROJECT_SORTS = ['updated', 'name'] as const
export type ProjectSort = (typeof PROJECT_SORTS)[number]

export const isProjectSort = (value: string): value is ProjectSort => PROJECT_SORTS.some((s) => s === value)

export interface ProjectListView {
  readonly q: string
  readonly scope: ProjectScope
  readonly sort: ProjectSort
}

const isMine = (project: Project) => project.access?.role === 'owner'

function inScope(project: Project, scope: ProjectScope): boolean {
  if (scope === 'all') return true
  return scope === 'mine' ? isMine(project) : !isMine(project)
}

function matches(project: Project, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase()
  return needle === '' || `${project.name}\n${project.description}`.toLocaleLowerCase().includes(needle)
}

/** The newest of updated/created, as a sortable ISO string ('' when neither is set). */
const touched = (project: Project) => (project.updated_at === '' ? project.created_at : project.updated_at)

function compare(sort: ProjectSort): (a: Project, b: Project) => number {
  if (sort === 'name') return (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return (a, b) => touched(b).localeCompare(touched(a))
}

/** The projects to show, in the order to show them. */
export function viewProjects(projects: readonly Project[], view: ProjectListView): Project[] {
  // `filter` returns a new array, so the sort never reorders the caller's list.
  return projects.filter((p) => inScope(p, view.scope) && matches(p, view.q)).sort(compare(view.sort))
}
