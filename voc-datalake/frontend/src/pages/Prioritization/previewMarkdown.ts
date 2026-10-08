/**
 * @fileoverview Heading overrides for a document EXCERPT rendered inside a row.
 *
 * The excerpt sits under the row's `h4` section headings ("Document Preview"),
 * so a PR/FAQ's own `# Title` rendered as an `h1` there put a level-1 heading in
 * the middle of the page outline — and the next `h4` section then skipped from 1
 * to 4 (axe `heading-order`). The excerpt's headings are demoted below the
 * section's level; the visual sizes are kept with classes, since `.md-content`
 * sizes headings by tag.
 *
 * A `.ts` module with `createElement` rather than `.tsx`: it exports a constant,
 * not a component, which the fast-refresh lint rule refuses in a JSX file.
 *
 * @module pages/Prioritization/previewMarkdown
 */
import { createElement } from 'react'
import type { Components } from 'react-markdown'
import type { ReactNode } from 'react'

type HeadingProps = { readonly children?: ReactNode }

/** Every heading below the excerpt's top two collapses to one level. */
const minorHeading = ({ children }: HeadingProps) => createElement('h6', null, children)

export const PREVIEW_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }: HeadingProps) => createElement('h5', { className: 'text-lg font-bold' }, children),
  h2: ({ children }: HeadingProps) => createElement('h6', { className: 'text-base' }, children),
  h3: minorHeading,
  h4: minorHeading,
  h5: minorHeading,
  h6: minorHeading,
}
