/**
 * What the app shell loads before any page: the modules `main.tsx` reaches through STATIC
 * imports (a lazy `import()` starts a chunk of its own). The 5.34 live test measured 8-10 s
 * first loads; 1.7 MB of shell JS was part of it, including the charts library (for `clsx`,
 * vendorChunks.test.ts), the assistant panel and the markdown renderer, none of which a page
 * needs before it renders. This pins them out of the shell.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importGraph, SRC, staticSpecifiers } from '@test/importGraph'

describe('the app shell', () => {
  const { files, packages } = importGraph('main.tsx')

  it('reaches the layout through static imports (the walk itself works)', () => {
    expect([...files].some((file) => file.endsWith('components/Layout/Layout.tsx'))).toBe(true)
  })

  it('installs the cross-tab sign-out listener itself, whatever else becomes lazy', () => {
    expect(staticSpecifiers(join(SRC, 'main.tsx'))).toContain('./services/crossTabSignOut')
  })

  it('loads no chart and no markdown library before a page asks for one', () => {
    expect([...packages].filter((name) => name === 'recharts' || name.startsWith('react-markdown') || name === 'remark-gfm'))
      .toStrictEqual([])
  })

  it('loads the assistant panel only when it first opens', () => {
    expect([...files].filter((file) => file.endsWith('assistant/components/AssistantPanel.tsx'))).toStrictEqual([])
  })
})
