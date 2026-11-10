/**
 * The form editor's tab strip follows the WAI-ARIA tabs pattern (live finding):
 * ArrowLeft / ArrowRight move between tabs (wrapping), Home / End jump to the
 * ends, the moved-to tab is selected and focused, and only the selected tab is
 * in the Tab order.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { at } from '@test/defined'
import FormEditor from './FormEditor'

function renderEditor() {
  render(<FormEditor form={null} categories={[]} onSave={vi.fn().mockResolvedValue(undefined)} onCancel={vi.fn()} validationPickerEnabled={false} />)
  return { user: userEvent.setup(), tabs: () => screen.getAllByRole('tab') }
}

describe('FormEditor tabs — keyboard', () => {
  it('moves right and left between tabs, selecting and focusing each', async () => {
    const { user, tabs } = renderEditor()
    at(tabs(), 0).focus()

    await user.keyboard('{ArrowRight}')
    expect(at(tabs(), 1)).toHaveAttribute('aria-selected', 'true')
    expect(at(tabs(), 1)).toHaveFocus()

    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(at(tabs(), 3)).toHaveFocus()
  })

  it('jumps to the first and last tab with Home and End', async () => {
    const { user, tabs } = renderEditor()
    at(tabs(), 0).focus()

    await user.keyboard('{End}')
    expect(at(tabs(), 3)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(at(tabs(), 0)).toHaveFocus()
  })

  it('keeps only the selected tab in the Tab order and labels the panel by it', () => {
    const { tabs } = renderEditor()

    expect(tabs().map((tab) => tab.getAttribute('tabindex'))).toStrictEqual(['0', '-1', '-1', '-1'])
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', at(tabs(), 0).id)
  })
})

/** Wave 4: the tab read "Validates" (jargon) and the Category tab showed a raw id (`mobile_app`) in plain view. */
describe('FormEditor tabs — plain words', () => {
  it('names the project-link tab in plain words', () => {
    const { tabs } = renderEditor()
    const names = tabs().map((tab) => tab.textContent)
    expect(names.some((name) => name.includes('Validates'))).toBe(false)
    expect(names.some((name) => name.includes('Project') || name.includes('Linked project'))).toBe(true)
  })

  it('keeps the developer snippet with its stored ids behind a closed disclosure', async () => {
    const { user, tabs } = renderEditor()
    await user.click(at(tabs(), 1))
    const snippet = screen.getByText("dimensions: { product: 'mobile_app' }")
    expect(snippet.closest('details')).not.toHaveAttribute('open')
  })
})
