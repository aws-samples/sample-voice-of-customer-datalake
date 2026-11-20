/**
 * @fileoverview The step palette's rows as a person uses them: a click adds the step below the graph, Enter adds it
 * after the selected step, a drag carries the block (and a plain step's bare type), the search narrows the groups and
 * says when nothing matches, and a disabled palette adds nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NodePalette } from './NodePalette'
import { BLOCK_MIME, PALETTE_MIME, parseBlock } from './model'
import type { PaletteBlock } from './model'

const stopAtPr = () => screen.getByRole('button', { name: 'Stop at PR' })

describe('the step palette', () => {
  it('adds a step below the graph on a click, and after the selected step on Enter', async () => {
    const onAdd = vi.fn<(block: PaletteBlock, after: boolean) => void>()
    render(<NodePalette onAdd={onAdd} schema="voc-workflow/2" />)
    await userEvent.click(stopAtPr())
    fireEvent.keyDown(stopAtPr(), { key: 'Enter' })
    fireEvent.keyDown(stopAtPr(), { key: 'a' })
    expect(onAdd.mock.calls.map(([block, after]) => [block.type, after]))
      .toStrictEqual([['stop_at_pr', false], ['stop_at_pr', true]])
  })

  it('drags the block it makes, and a plain step\'s bare type too', () => {
    render(<NodePalette onAdd={vi.fn()} schema="voc-workflow/2" />)
    const data = new Map<string, string>()
    const dataTransfer = { setData: (kind: string, value: string) => data.set(kind, value), effectAllowed: 'none',
      setDragImage: vi.fn() }
    fireEvent.dragStart(stopAtPr(), { dataTransfer })
    expect([parseBlock(data.get(BLOCK_MIME) ?? '')?.type, data.get(PALETTE_MIME), dataTransfer.effectAllowed])
      .toStrictEqual(['stop_at_pr', 'stop_at_pr', 'copy'])
    fireEvent.dragEnd(stopAtPr())
  })

  it('narrows the groups to the search, and says when no step matches', async () => {
    render(<NodePalette onAdd={vi.fn()} schema="voc-workflow/2" />)
    const search = screen.getByRole('searchbox', { name: 'Search the steps' })
    await userEvent.type(search, 'stop at')
    expect(stopAtPr()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'A person decides' })).toBeNull()
    await userEvent.clear(search)
    await userEvent.type(search, 'no step is called this')
    expect(screen.getByText('No step matches.')).toBeInTheDocument()
  })

  it('adds nothing while it is disabled', async () => {
    const onAdd = vi.fn()
    render(<NodePalette onAdd={onAdd} schema="voc-workflow/2" disabled />)
    await userEvent.click(stopAtPr())
    fireEvent.keyDown(stopAtPr(), { key: 'Enter' })
    expect([stopAtPr().hasAttribute('disabled'), onAdd.mock.calls.length]).toStrictEqual([true, 0])
  })
})
