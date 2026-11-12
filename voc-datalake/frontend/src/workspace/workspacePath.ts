/**
 * @fileoverview The workspace in the address: `/w/{slug}/…` (docs/multi-workspace.md, decision 15).
 *
 * The router is created once, at load (App.tsx), with `/w/{slug}` as its `basename` when the address starts
 * with one, so every route and every `<Link to="/…">` of the app works unchanged inside a workspace. Moving to
 * another workspace is therefore a full page load (`window.location.assign`), which also drops every cached
 * answer of the one being left.
 *
 * Only a slug the platform could have made becomes a base path: the rule of `lambda/shared/platform_workspaces.py`
 * (3 to 40 of `a-z`, `0-9` and `-`, not starting or ending with `-`, not a reserved word). Any other `/w/…`
 * address is a workspace the caller cannot be in, and the gate says so.
 *
 * @module workspace/workspacePath
 */

/** The longest slug `_SLUG` allows (the create form's input limit). */
export const SLUG_MAX_LENGTH = 40

/** `_SLUG` in lambda/shared/platform_workspaces.py, anchored. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

/** `RESERVED_SLUGS` in lambda/shared/platform_workspaces.py. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['admin', 'api', 'app', 'platform', 'www'])

/** The leading `/w/{segment}` of a path, whatever the segment. */
const WORKSPACE_PREFIX = /^\/w\/([^/]*)(?=\/|$)/

/** What the address says about the workspace: none, a well-formed slug, or a `/w/…` no workspace can have. */
export type PathWorkspace =
  | { readonly kind: 'none' }
  | { readonly kind: 'slug'; readonly slug: string }
  | { readonly kind: 'invalid' }

/** Whether `slug` is one the platform can create. */
export function isWorkspaceSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug)
}

/** Read the workspace from a pathname (`/w/acme/dashboard` → acme). */
export function parseWorkspacePath(pathname: string): PathWorkspace {
  const match = WORKSPACE_PREFIX.exec(pathname)
  if (match === null) return { kind: 'none' }
  const slug = match[1] ?? ''
  return isWorkspaceSlug(slug) ? { kind: 'slug', slug } : { kind: 'invalid' }
}

/** The address of `path` (an app path such as `/dashboard`, or `''`) inside the workspace `slug`. */
export function workspaceUrl(slug: string, path: string): string {
  return `/w/${slug}${path}`
}

/**
 * The workspace of this page load: read once, because the router's basename is fixed when App.tsx creates it.
 * Everything that compares `window.location.pathname` with an app route goes through {@link appPathname}.
 */
export const PAGE_WORKSPACE: PathWorkspace = parseWorkspacePath(window.location.pathname)

/**
 * The router's basename of this page load: `/w/{slug}` for a well-formed slug, else undefined (outside a
 * workspace, or a `/w/…` no workspace can have, which the gate answers with not-found).
 */
export const PAGE_BASENAME: string | undefined = PAGE_WORKSPACE.kind === 'slug' ? workspaceUrl(PAGE_WORKSPACE.slug, '') : undefined

/** The document address of an app path (`/projects/p1` → `/w/acme/projects/p1`): for a plain `href` or a copied link. */
export function pageHref(path: string): string {
  return `${PAGE_BASENAME ?? ''}${path}`
}

/**
 * `pathname` as the router sees it: without this page load's `/w/{slug}` (`/w/acme/chat` → `/chat`). For code
 * that reads `window.location.pathname` outside the router.
 */
export function appPathname(pathname: string = window.location.pathname, basename: string | undefined = PAGE_BASENAME): string {
  if (basename === undefined) return pathname
  if (pathname === basename) return '/'
  return pathname.startsWith(`${basename}/`) ? pathname.slice(basename.length) : pathname
}
