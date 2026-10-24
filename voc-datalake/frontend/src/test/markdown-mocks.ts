/**
 * @fileoverview `vi.mock` factories for the markdown renderer, for specs that
 * mount a component which renders markdown but assert on something else.
 *
 * `react-markdown` is ESM-only and pulls the whole remark pipeline; rendering
 * the children as plain text keeps those specs fast and lets `getByText` match
 * the source string.
 *
 * ```ts
 * vi.mock('react-markdown', () => import('@test/markdown-mocks').then(m => m.reactMarkdownMock()))
 * vi.mock('remark-gfm', () => import('@test/markdown-mocks').then(m => m.remarkGfmMock()))
 * ```
 */
import { vi } from 'vitest'

/** A `ReactMarkdown` that renders its markdown source verbatim. */
export function reactMarkdownMock() {
  return {
    default: ({ children }: { children: string }) => children,
  }
}

/** A no-op `remark-gfm` plugin. */
export function remarkGfmMock() {
  return { default: vi.fn() }
}
