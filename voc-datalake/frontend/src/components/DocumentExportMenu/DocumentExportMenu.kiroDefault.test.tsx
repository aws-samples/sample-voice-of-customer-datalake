/**
 * @fileoverview "Copy to Kiro" pastes the server's Kiro instructions
 * (`kiro_default_export_prompt`) ahead of the document. Since 3.00.00 a project's
 * stored per-project `kiro_export_prompt` (no longer editable anywhere) is never
 * read, even when a stale payload still carries it.
 *
 * Clipboard note: `userEvent.setup()` installs its own `navigator.clipboard` stub
 * to back `user.copy()`/`user.paste()`, and testing-library's `cleanup()` (run by
 * `test/setup.ts`'s `afterEach`) tears it down again. Verified consequence: each
 * test sees a different clipboard object and a different `writeText`. So the spy
 * must be created AFTER `setup()` in the same test — a spy taken before it stays
 * attached to the object `setup()` discards and records nothing, which is what
 * made only the FIRST clipboard test in a file fail. Because the object it wraps
 * does not outlive the test, the spy needs no explicit restore and cannot leak
 * into later files under `singleFork: true`.
 */
import {
  describe, it, expect, vi,
} from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentExportMenu from './DocumentExportMenu'
import { exportProject, prdDocument } from './documentExport-fixtures'
import type { ProjectDocument } from '../../api/types'
import type { Project } from '../../api/projectTypes'
import { at } from '@test/defined'

// No print or markdown mocks: these cases never open the PDF export, so neither
// the print window nor the markdown renderer is ever reached.

// A sentinel, not a copy of the real backend wording: pinning the real text here
// would fail on every copy edit and prove nothing. What matters is that the
// copied payload carries whatever `kiro_default_export_prompt` holds.
const DEFAULT_TEXT = 'SENTINEL backend default instructions'
const CUSTOM_TEXT = 'Use only TypeScript. Strict mode required.'

const mockDoc = prdDocument()

const mockPrfaqDoc: ProjectDocument = {
  ...mockDoc,
  document_id: 'doc-2',
  document_type: 'prfaq',
  title: 'Test PRFAQ',
}

const projectWithDefault = exportProject({
  kiro_default_export_prompt: DEFAULT_TEXT,
})

// A pre-3.00.00 payload: the retired field is not on `Project` any more, so it
// rides in through a spread the way a loose wire object would.
const staleStoredPrompt: Record<string, unknown> = { kiro_export_prompt: CUSTOM_TEXT }
const projectWithStaleCustom: Project = {
  ...projectWithDefault,
  ...staleStoredPrompt,
}

const projectWithNeither: Project = {
  ...projectWithDefault,
  kiro_default_export_prompt: '',
}

/**
 * Render the menu, invoke "Copy to Kiro", and return the copied text.
 *
 * Spy order is load-bearing — see the clipboard note in the file header.
 */
async function copyToKiro(doc: ProjectDocument, project: Project): Promise<string> {
  const user = userEvent.setup()
  const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText')
  render(<DocumentExportMenu document={doc} project={project} />)

  await user.click(screen.getByRole('button', { name: /download options/i }))
  await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

  expect(writeTextSpy).toHaveBeenCalledExactlyOnceWith(expect.any(String))
  return at(writeTextSpy.mock.calls, 0)[0]
}

describe('DocumentExportMenu — Copy to Kiro uses the server instructions', () => {
  it('starts with the default text', async () => {
    const copiedText = await copyToKiro(mockDoc, projectWithDefault)
    expect(copiedText.startsWith(`${DEFAULT_TEXT}\n\n---\n\n## PRD Document\n\n# Test PRD`)).toBe(true)
  })

  it('never prefixes a stale stored per-project prompt', async () => {
    // Regression (3.00.00): the saved per-project prompt still prefixed the copy
    // although nothing could edit it any more.
    const copiedText = await copyToKiro(mockDoc, projectWithStaleCustom)
    expect(copiedText).not.toContain(CUSTOM_TEXT)
    expect(copiedText.startsWith(DEFAULT_TEXT)).toBe(true)
  })

  it('copies just the document when no prompt is available', async () => {
    const copiedText = await copyToKiro(mockDoc, projectWithNeither)
    expect(copiedText).toContain('# Test PRD')
    expect(copiedText).not.toContain(DEFAULT_TEXT)
  })
})

describe('DocumentExportMenu — section heading matches document type', () => {
  it('uses "PRD Document" heading for prd document type', async () => {
    const copiedText = await copyToKiro(mockDoc, projectWithDefault)
    expect(copiedText).toContain('## PRD Document')
    expect(copiedText).not.toContain('## PR/FAQ Document')
  })

  it('uses "PR/FAQ Document" heading for prfaq document type', async () => {
    const copiedText = await copyToKiro(mockPrfaqDoc, projectWithDefault)
    expect(copiedText).toContain('## PR/FAQ Document')
    expect(copiedText).not.toContain('## PRD Document')
  })
})

describe('DocumentExportMenu — menu renders for kiro-capable documents', () => {
  it('offers Copy to Kiro for a project that follows the default', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithDefault} />)
    await user.click(screen.getByRole('button', { name: /download options/i }))
    expect(screen.getByRole('menuitem', { name: /copy to kiro/i })).toBeInTheDocument()
  })

  it('shows no tip pointing at the removed Export / MCP tab, even with no prompt at all', async () => {
    // The tip used to say "Configure Kiro prompt in the Export / MCP tab"; that tab
    // is gone (global MCP lives on /connect), so the hint would send people nowhere.
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithNeither} />)
    await user.click(screen.getByRole('button', { name: /download options/i }))
    expect(screen.getByRole('menuitem', { name: /copy to kiro/i })).toBeInTheDocument()
    expect(screen.queryByText(/Export \/ MCP/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Configure Kiro prompt/i)).not.toBeInTheDocument()
  })
})
