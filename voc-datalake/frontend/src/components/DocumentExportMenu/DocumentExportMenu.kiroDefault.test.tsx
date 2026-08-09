/**
 * @fileoverview Tests for criterion 7: the per-document "Copy to Kiro" output
 * begins with the same effective instructions as the steering file.
 *
 * "Both consumers must agree" — the prompt used in Copy to Kiro must match
 * what _build_steering_file produces server-side.
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
import type { ProjectDocument, Project } from '../../api/types'

// Mock printUtils (required by DocumentExportMenu)
vi.mock('../../utils/printUtils', () => ({
  openPrintWindow: vi.fn().mockReturnValue({ print: vi.fn() }),
}))
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => children,
}))
vi.mock('remark-gfm', () => ({ default: vi.fn() }))

// A sentinel, not a copy of the real backend wording — see the rationale in
// pages/ProjectDetail/KiroExportSettings.test.tsx. What matters here is that the
// copied payload carries whatever `kiro_default_export_prompt` holds.
const DEFAULT_TEXT = 'SENTINEL backend default instructions'
const CUSTOM_TEXT = 'Use only TypeScript. Strict mode required.'

const mockDoc: ProjectDocument = {
  document_id: 'doc-1',
  document_type: 'prd',
  title: 'Test PRD',
  content: '# Overview\n\nTest content.',
  created_at: '2025-01-01T00:00:00Z',
}

const mockPrfaqDoc: ProjectDocument = {
  ...mockDoc,
  document_id: 'doc-2',
  document_type: 'prfaq',
  title: 'Test PRFAQ',
}

const projectWithDefault: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: 'desc',
  status: 'active',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  persona_count: 0,
  document_count: 0,
  kiro_export_prompt: '',
  kiro_default_export_prompt: DEFAULT_TEXT,
}

const projectWithCustom: Project = {
  ...projectWithDefault,
  kiro_export_prompt: CUSTOM_TEXT,
}

const projectWithNeither: Project = {
  ...projectWithDefault,
  kiro_export_prompt: '',
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

  expect(writeTextSpy).toHaveBeenCalledOnce()
  return writeTextSpy.mock.calls[0][0]
}

describe('DocumentExportMenu — criterion 7: Copy to Kiro uses effective instructions', () => {
  it('uses the default text when the project has no stored prompt', async () => {
    expect(await copyToKiro(mockDoc, projectWithDefault)).toContain(DEFAULT_TEXT)
  })

  it('uses the project\'s own text when it has a stored prompt', async () => {
    expect(await copyToKiro(mockDoc, projectWithCustom)).toContain(CUSTOM_TEXT)
  })

  it('does NOT use the default text when the project has its own stored prompt', async () => {
    expect(await copyToKiro(mockDoc, projectWithCustom)).not.toContain(DEFAULT_TEXT)
  })

  it('copies just the document when no effective prompt is available', async () => {
    const copiedText = await copyToKiro(mockDoc, projectWithNeither)
    expect(copiedText).toContain('# Test PRD')
    expect(copiedText).not.toContain(DEFAULT_TEXT)
  })

  it('effective prompt for default project matches what _build_steering_file uses', async () => {
    // Both consumers must agree: the "Copy to Kiro" clipboard content must START
    // with the same effective instructions that _build_steering_file embeds in
    // the steering file. When the project follows the default (kiro_export_prompt
    // is empty), both must use kiro_default_export_prompt.
    const copiedText = await copyToKiro(mockDoc, projectWithDefault)
    expect(copiedText.startsWith(DEFAULT_TEXT)).toBe(true)
  })

  it('effective prompt for custom project matches what _build_steering_file uses', async () => {
    const copiedText = await copyToKiro(mockDoc, projectWithCustom)
    expect(copiedText.startsWith(CUSTOM_TEXT)).toBe(true)
  })
})

describe('DocumentExportMenu — section heading matches document type', () => {
  it('uses "PRD Document" heading for prd document type', async () => {
    const copiedText = await copyToKiro(mockDoc, projectWithCustom)
    expect(copiedText).toContain('## PRD Document')
    expect(copiedText).not.toContain('## PR/FAQ Document')
  })

  it('uses "PR/FAQ Document" heading for prfaq document type', async () => {
    const copiedText = await copyToKiro(mockPrfaqDoc, projectWithCustom)
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
})
