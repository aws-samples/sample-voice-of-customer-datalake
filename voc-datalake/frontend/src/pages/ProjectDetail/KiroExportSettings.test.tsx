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

const DEFAULT_TEXT = 'Build against the project material provided here rather than from assumptions.'

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
    expect(screen.getByText(new RegExp('Build against the project material', 'i'))).toBeInTheDocument()
  })

  it('shows the project\'s own text when it has a stored prompt', () => {
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)
    expect(screen.getByText(/Use only Rust/i)).toBeInTheDocument()
  })

  it('does not show the default text when the project has its own prompt', () => {
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)
    // The preview truncates at 300 chars; DEFAULT_TEXT start is unique enough
    expect(screen.queryByText(new RegExp('Build against the project material', 'i'))).not.toBeInTheDocument()
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

  it('clears the editor to empty when clicking "Use default template"', async () => {
    // "Use default template" sets prompt to '' so that saving stores an empty
    // kiro_export_prompt, keeping the project following the default automatically.
    // The preview (not the textarea) shows the effective prompt (defaultPrompt).
    const user = userEvent.setup()
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)

    // Open the editor
    await user.click(screen.getByRole('button', { name: /edit/i }))

    // Click "Use default template" — should clear the textarea, not fill with default text
    await user.click(screen.getByRole('button', { name: /use default template/i }))

    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveValue('')
  })

  it('saves empty string (not the default text) when clicking "Use default template" then Save', async () => {
    // Verifies the no-freeze design: saving after "Use default template" must
    // write '' to DynamoDB so future wording changes reach this project.
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<KiroExportSettings project={projectWithCustom} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: /edit/i }))
    await user.click(screen.getByRole('button', { name: /use default template/i }))
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave).toHaveBeenCalledWith('')
    expect(onSave).not.toHaveBeenCalledWith(DEFAULT_TEXT)
  })
})

describe('KiroExportSettings — the previewed text is attributed', () => {
  it('says the shown instructions are the default when there is no stored prompt', () => {
    // Without this the preview reads as text the user wrote. The Configure/Edit
    // label alone is too subtle to carry that distinction.
    render(<KiroExportSettings project={projectWithDefault} onSave={vi.fn()} />)
    expect(screen.getByText(/following the default instructions/i)).toBeInTheDocument()
  })

  it('does not claim the default is in use when the project has its own prompt', () => {
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)
    expect(screen.queryByText(/following the default instructions/i)).not.toBeInTheDocument()
  })

  it('names the actual button in the hint, taken from the button\'s own translation', () => {
    // The hint interpolates kiroExport.configure rather than repeating the word,
    // so it can never point at a button that does not exist by that name.
    render(<KiroExportSettings project={projectWithDefault} onSave={vi.fn()} />)

    const buttonLabel = screen.getByRole('button', { name: /configure/i }).textContent?.trim()
    expect(buttonLabel).toBeTruthy()
    expect(screen.getByText(/following the default instructions/i).textContent)
      .toContain(buttonLabel)
  })

  it('previews the default as the textarea placeholder so clearing is legible', async () => {
    // "Use default template" clears to '', which would otherwise look like an
    // accidental wipe. The placeholder shows the text that will actually apply.
    const user = userEvent.setup()
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /edit/i }))
    await user.click(screen.getByRole('button', { name: /use default template/i }))

    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveValue('')
    expect(textarea).toHaveAttribute('placeholder', DEFAULT_TEXT)
  })

  it('hides "Use default template" when no default is available', async () => {
    // baseProject omits kiro_default_export_prompt, so the button would clear the
    // textarea with nothing to fall back to.
    const user = userEvent.setup()
    const projectNoDefaultButCustom: Project = {
      ...baseProject,
      kiro_export_prompt: 'Custom only.',
    }
    render(<KiroExportSettings project={projectNoDefaultButCustom} onSave={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /edit/i }))

    expect(screen.queryByRole('button', { name: /use default template/i })).not.toBeInTheDocument()
  })
})

describe('KiroExportSettings — criterion 8: clearing returns to default', () => {
  it('calls onSave with empty string when user saves whitespace-only text', async () => {
    // Whitespace-only input is treated the same as empty: trimmed before saving
    // so the UI does not enter a misleading "Edit" state with a blank preview.
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<KiroExportSettings project={projectWithCustom} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    await user.clear(textarea)
    await user.type(textarea, '   ')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave).toHaveBeenCalledWith('')
  })

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

  it('reopens the editor from the stored value, discarding unsaved local edits', async () => {
    // handleEdit re-seeds the textarea from the project prop on every open. That
    // is what makes local state impossible to observe while stale, and it is why
    // handleSave deliberately does not sync `prompt` to the trimmed value. The
    // project prop does not change here, standing in for "parent has not
    // refetched yet" — the editor must still show server truth, not the old edit.
    const user = userEvent.setup()
    render(<KiroExportSettings project={projectWithCustom} onSave={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /edit/i }))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), '  Padded instructions.  ')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await user.click(screen.getByRole('button', { name: /edit/i }))
    expect(screen.getByRole('textbox')).toHaveValue(projectWithCustom.kiro_export_prompt)
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
    expect(screen.getByText(new RegExp('Build against the project material', 'i'))).toBeInTheDocument()
  })
})
