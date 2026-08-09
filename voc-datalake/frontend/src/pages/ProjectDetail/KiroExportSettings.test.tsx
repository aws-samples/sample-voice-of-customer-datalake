/**
 * @fileoverview Tests for KiroExportSettings component.
 *
 * Covers acceptance criteria 6 and 8:
 * 6. The editor shows the default when the project has none, and the project's
 *    own text when it has one.
 * 8. Clearing the field (saving empty) returns the project to following the
 *    default — verified here by checking what onSave receives.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import KiroExportSettings from './KiroExportSettings'
import type { Project } from '../../api/types'

const DEFAULT_TEXT = 'Build against the material in this workspace rather than from assumptions.'

const baseProject: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: 'A test project',
  status: 'active',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  persona_count: 0,
  document_count: 0,
}

const projectWithDefault: Project = {
  ...baseProject,
  kiro_export_prompt: '',
  kiro_default_export_prompt: DEFAULT_TEXT,
}

const projectWithCustom: Project = {
  ...baseProject,
  kiro_export_prompt: 'Use only Rust. No exceptions.',
  kiro_default_export_prompt: DEFAULT_TEXT,
}

describe('KiroExportSettings — criterion 6: shows effective instructions', () => {
  it('shows the default text in the preview when the project has no stored prompt', () => {
    render(<KiroExportSettings project={projectWithDefault} onSave={vi.fn()} />)
    // The default text should appear in the preview
    expect(screen.getByText(new RegExp('Build against the material', 'i'))).toBeInTheDocument()
  })

  it('shows the project\'s own text when it has a stored prompt', () => {
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)
    expect(screen.getByText(/Use only Rust/i)).toBeInTheDocument()
  })

  it('does not show the default text when the project has its own prompt', () => {
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)
    // The preview truncates at 300 chars; DEFAULT_TEXT start is unique enough
    expect(screen.queryByText(new RegExp('Build against the material', 'i'))).not.toBeInTheDocument()
  })

  it('shows "Configure" button when no stored prompt (following default)', () => {
    render(<KiroExportSettings project={projectWithDefault} onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: /configure/i })).toBeInTheDocument()
  })

  it('shows "Edit" button when the project has its own stored prompt', () => {
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
  })

  it('shows EmptyState when neither stored nor default prompt is available', () => {
    // This can happen if the response came from a list-route that omits kiro_default_export_prompt
    render(<KiroExportSettings project={baseProject} onSave={vi.fn()} />)
    expect(screen.getByText(/no kiro export prompt configured/i)).toBeInTheDocument()
  })

  it('prefills editor with the default when clicking "Use default template"', async () => {
    const user = userEvent.setup()
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)

    // Open the editor
    await user.click(screen.getByRole('button', { name: /edit/i }))

    // Click "Use default template" to populate the textarea with the default
    await user.click(screen.getByRole('button', { name: /use default template/i }))

    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveValue(DEFAULT_TEXT)
  })
})

describe('KiroExportSettings — criterion 8: clearing returns to default', () => {
  it('calls onSave with empty string when user clears the textarea', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<KiroExportSettings project={projectWithCustom} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    await user.clear(textarea)
    await user.click(screen.getByRole('button', { name: /save/i }))

    // onSave must receive the empty string — not the default text —
    // so that the stored record stays empty and follows future default changes.
    expect(onSave).toHaveBeenCalledWith('')
    expect(onSave).not.toHaveBeenCalledWith(DEFAULT_TEXT)
  })

  it('shows default text in preview after saving empty (component re-renders with new project)', () => {
    // After clearing, the parent re-renders with kiro_export_prompt = '' and
    // kiro_default_export_prompt still set — the component should show the default.
    const projectAfterClear: Project = {
      ...baseProject,
      kiro_export_prompt: '',
      kiro_default_export_prompt: DEFAULT_TEXT,
    }
    render(<KiroExportSettings project={projectAfterClear} onSave={vi.fn()} />)
    expect(screen.getByText(new RegExp('Build against the material', 'i'))).toBeInTheDocument()
  })
})
