/**
 * @fileoverview Stored ids inside free text (a memory, an agent run event, a
 * generated document) read as the labels a person knows: `technical_support` →
 * "Technical support" (or its configured name), `web_www_trustpilot_com` →
 * "Trustpilot", `proj_8f2c…` → the project's name.
 *
 * Only id-shaped tokens change: lower-case words joined by underscores, and
 * `proj_…` project ids. Text inside links and inline code is left as written.
 * Render-time only — the stored text never changes (the backend writes labels
 * for new text; this covers what was stored before).
 *
 * @module utils/labelKnownIds
 */

/** How each kind of id reads; `project` answers undefined for a project it does not know. */
export interface IdLabellers {
  readonly category: (id: string) => string
  readonly isCategory: (id: string) => boolean
  readonly source: (id: string) => string
  readonly project: (id: string) => string | undefined
  /** What an unknown project id reads as ("a project"). */
  readonly unknownProject: string
}

/** Links and `inline code` are passed through untouched. */
const PROTECTED_RE = /(https?:\/\/\S+|`[^`]*`)/g
/** `snake_case` ids (2+ parts), and project ids (`proj_` + an opaque tail). */
const ID_RE = /(?<![\w./@-])(proj_[A-Za-z0-9_-]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w/@-]|\.\w)/g
const PROJECT_ID_RE = /^proj_/

function labelId(id: string, labellers: IdLabellers): string {
  if (PROJECT_ID_RE.test(id)) return labellers.project(id) ?? labellers.unknownProject
  return labellers.isCategory(id) ? labellers.category(id) : labellers.source(id)
}

/** `text` with every id-shaped token outside links and code replaced by its label. */
export function labelKnownIds(text: string, labellers: IdLabellers): string {
  return text
    .split(PROTECTED_RE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(ID_RE, (id) => labelId(id, labellers))))
    .join('')
}
