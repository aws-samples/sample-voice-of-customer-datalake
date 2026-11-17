/**
 * The bundle split of the shared document component (§6.5 "Bundle size"): reading never loads the editor. Nothing the
 * light reader, the source views, the diffs or the surface's read path import statically reaches `@tiptap/*` or the
 * canvas (components/Document/edit/editor), and neither does any page of the Agents route: there TipTap would add about
 * 196 KB gzip to screens that only read. The editor engine loads with `import()`, on Edit (its own chunk).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importGraph, SRC } from '@test/importGraph'

/** The production modules of a folder of the document component. */
const modulesOf = (folder: string) => readdirSync(join(SRC, 'components/Document', folder))
  .filter((name) => /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) && !name.includes('-fixtures'))
  .map((name) => `components/Document/${folder}/${name}`)

/** The reader, the text views, the diffs and the surface (its edit engine is `import()`ed on Edit: never followed). */
const READ_PATH = [
  ...modulesOf('read'), ...modulesOf('text'), ...modulesOf('diff'), ...modulesOf('surface'), ...modulesOf('conflict'),
  'components/Document/DocumentSurface.tsx', 'components/Document/edit/MarkdownEdit.tsx',
]
/** Every page the Agents route loads (lazyPages.ts). */
const AGENTS_PAGES = [
  'pages/Agents/Agents.tsx', 'pages/Agents/AgentDetail.tsx', 'pages/Agents/SetupGuide/SetupGuide.tsx',
  'pages/Agents/WorkflowPage.tsx', 'pages/Agents/WorkflowTemplatePage.tsx', 'pages/Agents/RunWorkspace/RunWorkspace.tsx',
  // 7.52.00 C3: the Registry and Skills pages (orchestrationRoutes.registry.tsx); the Propose sheet loads the canvas on Edit.
  'pages/Agents/Registry/RegistryPage.tsx', 'pages/Agents/EngineeringSkills.tsx',
]

/** What a graph reaches of the editor: TipTap's packages and the canvas's own modules. */
function editorIn(entries: readonly string[]): string[] {
  const { files, packages } = importGraph(...entries)
  return [
    ...[...packages].filter((name) => name.startsWith('@tiptap/')),
    ...[...files].filter((file) => file.includes('/components/Document/edit/editor/')).map((file) => file.slice(SRC.length + 1)),
  ]
}

describe('the light reader', () => {
  it('covers the reader, the source views and the diffs (the walk itself works)', () => {
    const { files } = importGraph(...READ_PATH)

    expect(READ_PATH.length).toBeGreaterThanOrEqual(10)
    expect([...files].some((file) => file.endsWith('components/Document/edit/markdown/links.ts'))).toBe(true)
  })

  it('never reaches the editor', () => {
    expect(editorIn(READ_PATH)).toStrictEqual([])
  })
})

describe('the Agents route', () => {
  it('reaches markdown through its pages (the walk itself works)', () => {
    expect(importGraph(...AGENTS_PAGES).packages.has('react-markdown')).toBe(true)
  })

  it('never reaches the editor', () => {
    expect(editorIn(AGENTS_PAGES)).toStrictEqual([])
  })
})
