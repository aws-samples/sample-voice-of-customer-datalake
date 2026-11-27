/**
 * The Sources card's drop zone (moved from the docs card, 7.104.00): exactly one picker per activation, Enter on
 * keydown and Space on keyup (the ARIA APG button pattern), no picker for a held Space or a stray keyup, the drag
 * highlight kept while the drag moves over the zone's own children, and a text drag left alone.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { render } from '@test/test-utils'
import { zoneChild } from './imaging-fixtures'
import SourceDropZone from './SourceDropZone'

function renderZone() {
  const onFiles = vi.fn()
  render(<SourceDropZone onFiles={onFiles} />)
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  const clicks = vi.fn()
  input.addEventListener('click', clicks)
  return { zone: screen.getByRole('button', { name: /drop files here/i }), clicks, onFiles }
}

describe('SourceDropZone', () => {
  it('is a focusable button, not a label, that opens the picker once per pointer activation', () => {
    const { zone, clicks } = renderZone()
    fireEvent.click(zone)
    expect([zone.tagName, zone.getAttribute('tabIndex'), clicks.mock.calls.length]).toStrictEqual(['DIV', '0', 1])
  })

  it('opens the picker on Enter at keydown and on Space at keyup, once each', () => {
    const { zone, clicks } = renderZone()
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(fireEvent.keyDown(zone, { key: ' ' })).toBe(false)
    expect(clicks).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).toHaveBeenCalledTimes(2)
  })

  it('opens nothing while Space is held, nor for a keyup it never saw go down, nor after a blur', () => {
    const { zone, clicks } = renderZone()
    fireEvent.keyUp(zone, { key: ' ' })
    fireEvent.keyDown(zone, { key: ' ' })
    fireEvent.keyDown(zone, { key: ' ', repeat: true })
    fireEvent.blur(zone)
    fireEvent.keyUp(zone, { key: ' ' })
    expect(clicks).not.toHaveBeenCalled()
  })

  it('keeps the highlight while a file drag moves onto its own children, and drops it when the drag leaves', () => {
    const { zone } = renderZone()
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ['Files'] } })
    fireEvent(zone, new MouseEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: zoneChild(zone, 'div') }))
    expect(zone).toHaveAttribute('data-drag-active', 'true')
    fireEvent(zone, new MouseEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: document.body }))
    expect(zone).toHaveAttribute('data-drag-active', 'false')
  })

  it('leaves a text drag alone: no drop target, no highlight', () => {
    const { zone } = renderZone()
    const over = fireEvent.dragOver(zone, { dataTransfer: { types: ['text/plain'], files: [] } })
    const entered = fireEvent.dragEnter(zone, { dataTransfer: { types: ['text/plain'], files: [] } })
    expect([over, entered, zone.getAttribute('data-drag-active')]).toStrictEqual([true, true, 'false'])
  })

  it('hands the dropped files over as a list', () => {
    const { zone, onFiles } = renderZone()
    const file = new File(['# a'], 'a.md', { type: 'text/markdown' })
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } })
    expect(onFiles).toHaveBeenCalledWith([file])
  })
})
