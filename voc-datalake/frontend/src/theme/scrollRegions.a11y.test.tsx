/**
 * Scrollable regions are keyboard-reachable and named (E2E F8, axe
 * `scrollable-region-focusable`), and complementary landmarks are unique (F9,
 * axe `landmark-unique`).
 *
 * A region that scrolls but holds nothing focusable — the Connect mcp.json snippet, or the
 * workflow editor's side columns in a read-only editor — cannot be scrolled from
 * the keyboard at all, so its overflow is unreadable without a mouse.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

/** The opening tag (up to its closing `>`) of the first element in `file` whose source contains `marker`. */
function openingTag(file: string, marker: string): string {
  const source = readFileSync(join(SRC, file), 'utf8')
  const at = source.indexOf(marker)
  if (at === -1) throw new Error(`${marker} not found in ${file}`)
  const start = source.lastIndexOf('<', at)
  return source.slice(start, source.indexOf('>', at) + 1)
}

describe.each([
  ['workflow editor step palette', 'components/WorkflowEditor/WorkflowEditor.tsx', "aria-label={t('editor.palette')}"],
  ['workflow editor step settings', 'components/WorkflowEditor/WorkflowEditor.tsx', "aria-label={t('editor.panel')}"],
  ['agent run list', 'pages/Agents/RunsTab.tsx', "aria-label={t('run.list')} className=\"card p-2"],
  ['raw prototype output', 'pages/ProjectDetail/DocumentPrototypeView.tsx', "aria-label={t('documents.prototype.rawLabel'"],
  ['Connect mcp.json snippet', 'pages/Connect/EndpointCard.tsx', "aria-label={t('connect.mcpJsonLabel')}"],
  ['GitHub label table', 'pages/Dashboard/GitHubInsights.tsx', "aria-label={t('github.byLabel')}"],
])('%s', (_name, file, label) => {
  it('is focusable and named', () => {
    const tag = openingTag(file, label)
    expect(tag).toContain('tabIndex={0}')
    expect(tag).toMatch(/overflow-(y-|x-)?auto/)
  })
})

describe('app sidebar', () => {
  it('is a named complementary landmark, so page asides beside it stay unique', () => {
    expect(openingTag('components/Layout/SidebarComponents.tsx', "aria-label={t('common:sidebar.label')}")).toMatch(/^<aside\b/)
  })
})
