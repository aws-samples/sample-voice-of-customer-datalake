/**
 * @fileoverview Tests for criterion 7: the per-document "Copy to Kiro" output
 * begins with the same effective instructions as the steering file.
 *
 * "Both consumers must agree" — the prompt used in Copy to Kiro must match
 * what _build_steering_file produces server-side.
 */
import {
  describe, it, expect, vi, beforeEach,
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

const DEFAULT_TEXT = 'Build against the material in this workspace rather than from assumptions.'
const CUSTOM_TEXT = 'Use only TypeScript. Strict mode required.'

const mockDoc: ProjectDocument = {
  document_id: 'doc-1',
  document_type: 'prd',
  title: 'Test PRD',
  content: '# Overview\n\nTest content.',
  created_at: '2025-01-01T00:00:00Z',
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

// Shared mock function for clipboard. Reset before each test to ensure
// clean call history regardless of test position within the file.
const writeTextMock = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

beforeEach(() => {
  writeTextMock.mockClear()
  // Replace the clipboard write function directly on the existing mock object.
  // This avoids re-defining the entire clipboard property (which can interfere
  // with vi.spyOn), while still giving each test a fresh call history.
  navigator.clipboard.writeText = writeTextMock
})

// A non-clipboard test that runs first so that setup.ts's afterEach has a
// chance to call vi.clearAllMocks() before any clipboard spy test runs.
// This is necessary because vi.spyOn on navigator.clipboard.writeText is
// unreliable in the very first test of a file in a singleFork environment
// where previous test files may have left stale spy descriptors on the
// clipboard property.
describe('DocumentExportMenu — menu renders for kiro-capable documents', () => {
  it('shows the copy-to-kiro button for prd documents', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithDefault} />)
    await user.click(screen.getByRole('button', { name: /download options/i }))
    expect(screen.getByRole('menuitem', { name: /copy to kiro/i })).toBeInTheDocument()
  })
})

describe('DocumentExportMenu — criterion 7: Copy to Kiro uses effective instructions', () => {
  it('uses the default text when the project has no stored prompt', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithDefault} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

    expect(writeTextMock).toHaveBeenCalledOnce()
    expect(writeTextMock.mock.calls[0][0]).toContain(DEFAULT_TEXT)
  })

  it('uses the project\'s own text when it has a stored prompt', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithCustom} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

    expect(writeTextMock).toHaveBeenCalledWith(
      expect.stringContaining(CUSTOM_TEXT),
    )
  })

  it('does NOT use the default text when the project has its own stored prompt', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithCustom} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

    expect(writeTextMock.mock.calls[0][0]).not.toContain(DEFAULT_TEXT)
  })

  it('copies just the document when no effective prompt is available', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithNeither} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

    const copiedText = writeTextMock.mock.calls[0][0]
    expect(copiedText).toContain('# Test PRD')
    expect(copiedText).not.toContain(DEFAULT_TEXT)
  })

  it('effective prompt for default project matches what _build_steering_file uses', async () => {
    // Both consumers must agree: the "Copy to Kiro" clipboard content must START
    // with the same effective instructions that _build_steering_file embeds in
    // the steering file. When the project follows the default (kiro_export_prompt
    // is empty), both must use kiro_default_export_prompt.
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithDefault} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

    const copiedText = writeTextMock.mock.calls[0][0]
    // The clipboard output must start with the default instructions since
    // there is no stored override — same as what _build_steering_file produces.
    expect(copiedText.startsWith(DEFAULT_TEXT)).toBe(true)
  })

  it('effective prompt for custom project matches what _build_steering_file uses', async () => {
    const user = userEvent.setup()
    render(<DocumentExportMenu document={mockDoc} project={projectWithCustom} />)

    await user.click(screen.getByRole('button', { name: /download options/i }))
    await user.click(screen.getByRole('menuitem', { name: /copy to kiro/i }))

    expect(writeTextMock.mock.calls[0][0].startsWith(CUSTOM_TEXT)).toBe(true)
  })
})
