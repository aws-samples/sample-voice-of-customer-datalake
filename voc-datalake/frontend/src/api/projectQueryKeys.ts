/**
 * @fileoverview Query keys for project data that is read from more than one feature.
 *
 * `['project', id]` has a reader outside the project page — Breadcrumbs titles the
 * header crumb with the project's name — so the two sides must not be able to
 * drift. A key spelled as a literal in both places looks correct right up until
 * one of them is renamed, and nothing fails: the page keeps working and the crumb
 * silently falls back to a generic label.
 *
 * It lives here rather than beside `projectJobsKey`/`productContextKey` in
 * `pages/ProjectDetail/useProjectData.ts` for one reason: that module imports
 * `projectsApi`, and the header is in the always-loaded layout chunk. Importing a
 * constant from it would put the project page's data layer in that chunk too, or
 * leave code-splitting resting on tree-shaking a module with imports. This file
 * has no imports at all.
 *
 * The rule that follows: a query key stays private to its page until a second
 * feature reads it, and moves here when one does.
 *
 * @module api/projectQueryKeys
 */

/** The project detail record — `projectsApi.getProject`. */
export const projectKey = (id: string | undefined) => ['project', id] as const

/**
 * The project list — `projectsApi.getProjects`.
 *
 * Earned its place here by the rule above: three features read it (Projects,
 * Prioritization, and the feedback-form editor's validation-link picker), and
 * Projects invalidates it on every mutation — so every reader is coupled to an
 * invalidation it had better be able to name.
 */
export const projectsKey = () => ['projects'] as const
