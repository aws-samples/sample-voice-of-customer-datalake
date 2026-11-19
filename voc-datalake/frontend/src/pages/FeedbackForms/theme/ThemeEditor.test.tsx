/**
 * The theme editor (audit §2.2, F5): presets and "Save as brand…" (an admin's, asked first), Mode with the palette
 * being edited (told to the preview), the colour fields validated as typed, corners, font and size, and the live
 * contrast table with its notes and one-click suggestions, all written into the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormTheme } from '../model/formsV2'
import { DEFAULT_THEME } from '../model/formsV2'

interface BrandState {
  brand: FormTheme | null
  canSave: boolean
  save: ReturnType<typeof vi.fn<(theme: FormTheme) => Promise<unknown>>>
}

const brand = vi.hoisted((): BrandState => ({ brand: null, canSave: true, save: vi.fn<(theme: FormTheme) => Promise<unknown>>() }))

vi.mock('./useFormBrand', async (importOriginal) => {
  const real = await importOriginal<typeof import('./useFormBrand')>()
  return {
    ...real,
    useFormBrand: () => ({ brand: brand.brand, canSave: brand.canSave, save: brand.save, saving: false, saved: false, failed: false }),
  }
})

import { renderWithDraft, sampleForm } from '../test/draftHarness'
import ThemeEditor from './ThemeEditor'

const BRAND: FormTheme = { ...DEFAULT_THEME, primary_color: '#0552c2', border_radius: '16px', font: 'rounded' }
const themed = (theme: Partial<FormTheme>) => sampleForm({ theme: { ...DEFAULT_THEME, ...theme } })

function renderEditor(theme: Partial<FormTheme> = {}) {
  const onScheme = vi.fn<(scheme: 'light' | 'dark' | null) => void>()
  const harness = renderWithDraft(<ThemeEditor onEditingSchemeChange={onScheme} />, themed(theme))
  const current = () => harness.probe.current?.form.theme
  return { ...harness, onScheme, current, user: userEvent.setup() }
}

beforeEach(() => {
  brand.brand = null
  brand.canSave = true
  brand.save.mockReset().mockResolvedValue({ success: true })
})

afterEach(() => { vi.clearAllMocks() })

describe('presets', () => {
  it('sets the whole theme, says which one it is, and offers Your brand once one is saved', async () => {
    const editor = renderEditor()
    const presets = screen.getByRole('group', { name: 'Preset' })
    expect(within(presets).getByRole('button', { name: 'VoC light' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(presets).queryByRole('button', { name: 'Your brand' })).not.toBeInTheDocument()
    await editor.user.click(within(presets).getByRole('button', { name: 'High contrast' }))
    expect(editor.current()).toMatchObject({ mode: 'auto', primary_color: '#0552c2', dark: { primary_color: '#00d4ff' } })
  })

  it('applies the saved brand', async () => {
    brand.brand = BRAND
    const editor = renderEditor()
    await editor.user.click(screen.getByRole('button', { name: 'Your brand' }))
    expect(editor.current()).toStrictEqual(BRAND)
  })

  it('resets to the preset picked after an edit', async () => {
    const editor = renderEditor()
    await editor.user.click(screen.getByRole('button', { name: 'VoC dark' }))
    const text = screen.getByRole('textbox', { name: 'Primary' })
    await editor.user.clear(text)
    await editor.user.type(text, '#123456')
    expect(editor.current()?.dark.primary_color).toBe('#123456')
    await editor.user.click(screen.getByRole('button', { name: 'Reset to VoC dark' }))
    expect(editor.current()?.dark.primary_color).toBe('#bd8fff')
  })
})

describe('Save as brand…', () => {
  it('asks first, then saves the style as the workspace brand', async () => {
    const editor = renderEditor({ primary_color: '#0552c2' })
    await editor.user.click(screen.getByRole('button', { name: 'Save as brand…' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('New forms in this workspace will start on it')
    await editor.user.click(within(dialog).getByRole('button', { name: 'Save as brand' }))
    expect(brand.save).toHaveBeenCalledWith({ ...DEFAULT_THEME, primary_color: '#0552c2' })
  })

  it('stays off for anyone but an admin, and says why in words', async () => {
    brand.canSave = false
    const editor = renderEditor()
    const button = screen.getByRole('button', { name: 'Save as brand…' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription("Only this workspace's admins can save its brand.")
    await editor.user.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays off while the text is unreadable', () => {
    renderEditor({ text_color: '#9ca3af' })
    expect(screen.getByRole('button', { name: 'Save as brand…' }))
      .toHaveAccessibleDescription('Make the text readable (at least 3:1) before saving this style as your brand.')
  })
})

describe('mode and the palette being edited', () => {
  it('edits the dark palette in Dark, and tells the preview', async () => {
    const editor = renderEditor()
    expect(editor.onScheme).toHaveBeenLastCalledWith('light')
    await editor.user.click(within(screen.getByRole('group', { name: 'Mode' })).getByRole('button', { name: 'Dark' }))
    expect(editor.onScheme).toHaveBeenLastCalledWith('dark')
    expect(screen.getByRole('textbox', { name: 'Background' })).toHaveValue('#19161d')
  })

  it('in Auto, asks which palette is edited', async () => {
    const editor = renderEditor({ mode: 'auto' })
    const editing = screen.getByRole('group', { name: 'Editing' })
    await editor.user.click(within(editing).getByRole('button', { name: 'Dark' }))
    const text = screen.getByRole('textbox', { name: 'Text' })
    await editor.user.clear(text)
    await editor.user.type(text, '#eeeeee')
    expect([editor.current()?.dark.text_color, editor.current()?.text_color, editor.onScheme.mock.lastCall]).toStrictEqual(['#eeeeee', '#19161d', ['dark']])
  })

  it('gives the device its say again when it goes', () => {
    const editor = renderEditor()
    editor.unmount()
    expect(editor.onScheme).toHaveBeenLastCalledWith(null)
  })
})

describe('colours', () => {
  it('takes a hex colour as it is typed, and says why it refuses anything else', async () => {
    const editor = renderEditor()
    const field = screen.getByRole('textbox', { name: 'Primary' })
    await editor.user.clear(field)
    await editor.user.type(field, '#12')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(expect.stringContaining('Use a hex colour like #8e48ff.'))
    expect(editor.current()?.primary_color).toBe('#8e48ff')
    await editor.user.type(field, '3')
    expect(editor.current()?.primary_color).toBe('#123')
  })

  it('takes the swatch as a colour too', () => {
    const editor = renderEditor()
    fireEvent.change(screen.getByLabelText('Background: pick a colour'), { target: { value: '#fafafa' } })
    expect(editor.current()?.background_color).toBe('#fafafa')
  })
})

describe('the contrast table', () => {
  it('says each pair in words, with an icon, never colour alone', () => {
    renderEditor()
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => row.textContent)
    expect(rows).toStrictEqual([
      'Text on background(min 4.5:1)17.9:1AA', 'Primary on background(min 3:1)4.6:1AA',
      'Button label on primary(min 4.5:1)4.6:1AA', 'Option edge(min 3:1)4.0:1AA',
    ])
  })

  it('blocks Publish below 3:1, notes it on the text field, and fixes it in one click', async () => {
    const editor = renderEditor({ text_color: '#9ca3af' })
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent("Text on the background is 2.5:1, under 3:1: respondents can't read it. Publishing waits for this; saving still works.")
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveAccessibleDescription(expect.stringContaining('under 3:1'))
    await editor.user.click(within(note).getByRole('button', { name: 'Use #6f7681 (4.6:1)' }))
    expect(editor.current()?.text_color).toBe('#6f7681')
  })

  it('only warns on a live form kept on its own unreadable theme, and blocks again once its colours change', () => {
    const harness = renderWithDraft(<ThemeEditor />, { ...themed({ text_color: '#9ca3af' }), enabled: true })
    expect(screen.getByRole('note')).toHaveTextContent("This form's text is hard to read (2.5:1, under 3:1). Fix its colours; until then, your other changes still go live.")
    expect(screen.getByRole('note')).not.toHaveTextContent('Publishing waits')
    fireEvent.change(screen.getByRole('textbox', { name: 'Text' }), { target: { value: '#b0b0b0' } })
    expect(harness.probe.current?.form.theme.text_color).toBe('#b0b0b0')
    expect(screen.getByRole('note')).toHaveTextContent('Publishing waits for this; saving still works.')
  })

  it('warns about a faint primary and offers the nearest one that passes', async () => {
    const editor = renderEditor({ primary_color: '#f5c518' })
    await editor.user.click(screen.getByRole('button', { name: 'Use #b39018 (3.0:1)' }))
    expect(editor.current()?.primary_color).toBe('#b39018')
  })

  it('in Auto, says when the other palette has problems', async () => {
    const editor = renderEditor({ mode: 'auto', dark: { ...DEFAULT_THEME.dark, text_color: '#333333' } })
    expect(screen.getByText('The dark palette has 1 contrast problem.')).toBeInTheDocument()
    await editor.user.click(screen.getByRole('button', { name: 'Edit dark' }))
    expect(editor.onScheme).toHaveBeenLastCalledWith('dark')
  })
})

describe('corners, font and size', () => {
  it('sets the corners from the presets and the slider', async () => {
    const editor = renderEditor()
    await editor.user.click(screen.getByRole('button', { name: 'Large 16' }))
    expect(editor.current()?.border_radius).toBe('16px')
    fireEvent.change(screen.getByRole('slider', { name: 'Corner radius' }), { target: { value: '5' } })
    expect(editor.current()?.border_radius).toBe('5px')
  })

  it('offers the page font for the script embed only, and a large size', async () => {
    const editor = renderEditor()
    await editor.user.selectOptions(screen.getByRole('combobox', { name: 'Font' }), 'Same as your page (script embed only)')
    expect(screen.getByRole('combobox', { name: 'Font' })).toHaveAccessibleDescription(expect.stringContaining('Only the script embed'))
    await editor.user.click(screen.getByRole('button', { name: 'Large' }))
    expect([editor.current()?.font, editor.current()?.text_size]).toStrictEqual(['inherit', 'large'])
  })
})
