/**
 * @fileoverview Tests for ConfirmModal component.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmModal from './ConfirmModal'

describe('ConfirmModal', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Delete Item',
    message: 'Are you sure you want to delete this item?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }

  describe('visibility', () => {
    it('renders nothing when isOpen is false', () => {
      const { container } = render(<ConfirmModal {...defaultProps} isOpen={false} />)
      expect(container).toBeEmptyDOMElement()
    })

    it('renders modal when isOpen is true', () => {
      render(<ConfirmModal {...defaultProps} />)
      expect(screen.getByText('Delete Item')).toBeInTheDocument()
    })
  })

  describe('content', () => {
    it('displays title and message', () => {
      render(<ConfirmModal {...defaultProps} />)
      expect(screen.getByText('Delete Item')).toBeInTheDocument()
      expect(screen.getByText('Are you sure you want to delete this item?')).toBeInTheDocument()
    })

    it('displays default button labels', () => {
      render(<ConfirmModal {...defaultProps} />)
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    })

    it('displays custom button labels', () => {
      render(
        <ConfirmModal
          {...defaultProps}
          confirmLabel="Yes, Remove"
          cancelLabel="No, Keep"
        />
      )
      expect(screen.getByRole('button', { name: 'Yes, Remove' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'No, Keep' })).toBeInTheDocument()
    })
  })

  describe('variants', () => {
    it('applies danger variant styling by default', () => {
      render(<ConfirmModal {...defaultProps} />)
      const confirmButton = screen.getByRole('button', { name: 'Delete' })
      expect(confirmButton).toHaveClass('bg-red-600')
    })

    it('applies warning variant styling', () => {
      render(<ConfirmModal {...defaultProps} variant="warning" />)
      const confirmButton = screen.getByRole('button', { name: 'Delete' })
      expect(confirmButton).toHaveClass('bg-amber-600')
    })

    it('applies info variant styling', () => {
      render(<ConfirmModal {...defaultProps} variant="info" />)
      const confirmButton = screen.getByRole('button', { name: 'Delete' })
      expect(confirmButton).toHaveClass('bg-blue-600')
    })
  })

  describe('interactions', () => {
    it('calls onConfirm when confirm button is clicked', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      render(<ConfirmModal {...defaultProps} onConfirm={onConfirm} />)
      
      await user.click(screen.getByRole('button', { name: 'Delete' }))
      
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup()
      const onCancel = vi.fn()
      render(<ConfirmModal {...defaultProps} onCancel={onCancel} />)
      
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      
      expect(onCancel).toHaveBeenCalledTimes(1)
    })

    it('calls onCancel when backdrop is clicked', async () => {
      const user = userEvent.setup()
      const onCancel = vi.fn()
      render(<ConfirmModal {...defaultProps} onCancel={onCancel} />)
      
      const backdrop = screen.getByTestId('confirm-modal-backdrop')
      await user.click(backdrop)
      expect(onCancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('loading state', () => {
    it('disables buttons when isLoading is true', () => {
      render(<ConfirmModal {...defaultProps} isLoading={true} />)
      
      expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    })

    it('shows loading spinner when isLoading is true', () => {
      render(<ConfirmModal {...defaultProps} isLoading={true} />)
      
      expect(screen.getByTestId('confirm-modal-spinner')).toBeInTheDocument()
    })
  })
})
