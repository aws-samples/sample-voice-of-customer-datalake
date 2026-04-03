import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEscapeKey } from './useEscapeKey'

describe('useEscapeKey', () => {
  it('calls onClose when Escape is pressed and isOpen is true', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeKey(true, onClose))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call onClose when isOpen is false', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeKey(false, onClose))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not call onClose for non-Escape keys', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeKey(true, onClose))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('cleans up listener on unmount', () => {
    const onClose = vi.fn()
    const { unmount } = renderHook(() => useEscapeKey(true, onClose))

    unmount()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes listener when isOpen changes to false', () => {
    const onClose = vi.fn()
    const { rerender } = renderHook(
      ({ isOpen }) => useEscapeKey(isOpen, onClose),
      { initialProps: { isOpen: true } },
    )

    rerender({ isOpen: false })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(onClose).not.toHaveBeenCalled()
  })
})
