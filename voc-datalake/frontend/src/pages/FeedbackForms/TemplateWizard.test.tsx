/**
 * #283 stage 2: TemplateWizard was one of the two keyboard traps — no
 * role="dialog", a fused overlay, and Escape did nothing.
 *
 * Its dismiss prop is `onCancel`, not `onClose` like every other ModalShell
 * adopter, which makes it the riskiest wiring in the migration. `tsc` proved the
 * prop exists; only a test proves it is what dismissal actually calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TemplateWizard from './TemplateWizard'

const onSelect = vi.fn()
const onCancel = vi.fn()

function renderWizard() {
  return render(<TemplateWizard onSelect={onSelect} onCancel={onCancel} />)
}

describe('TemplateWizard dialog semantics (ModalShell adoption)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is exposed as a modal dialog named by its visible heading', () => {
    renderWizard()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // Named via aria-labelledby, so the accessible name cannot drift from the
    // heading on screen.
    expect(dialog).toHaveAccessibleName('Create New Form')
  })

  it('calls onCancel when Escape is pressed', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel on overlay click but not on panel click', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('modal-overlay'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
