/**
 * The light reader: the canvas's callouts, to-dos, heading ids and raw source, the Contents out of the same parse,
 * and one parse per version of a text (the large-document fixture: the page re-rendering never parses it again).
 */
import { render, screen } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { largeMarkdown } from '../edit/markdown/large-document-fixtures'
import MarkdownRead from './MarkdownRead'
import { markdownPolicy } from './markdownPolicy'
import { remarkParity } from './remarkParity'
import type { OutlineItem } from '../types'

vi.mock('./remarkParity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remarkParity')>()
  return { remarkParity: vi.fn(actual.remarkParity) }
})

/** Over 200,000 characters, as the canvas's own large-document spec. */
const LARGE = largeMarkdown(200_000)

function renderRead(source: string, onOutline?: (items: readonly OutlineItem[]) => void) {
  return render(<MemoryRouter><MarkdownRead source={source} policy={markdownPolicy.stored} onOutline={onOutline} /></MemoryRouter>)
}

describe('MarkdownRead', () => {
  it('reads a GFM alert as the canvas callout: its kind and name, the marker gone', () => {
    renderRead('> [!WARNING]\n> Watch the budget.')
    const note = screen.getByRole('note', { name: 'Warning' })

    expect(note).toHaveAttribute('data-callout', 'warning')
    expect(note).toHaveTextContent(/^Watch the budget\.$/u)
  })

  it('shows a to-do as a read-only box named as on the canvas, outside the text', () => {
    renderRead('- [x] Ship it')
    const box = screen.getByRole('checkbox', { name: 'Done' })

    expect(box).toBeChecked()
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute('data-anchor-skip')
  })

  it('gives headings the canvas ids, repeats numbered, and reports the h1–h3 as the Contents', () => {
    const onOutline = vi.fn<(items: readonly OutlineItem[]) => void>()
    renderRead('# Plan\n\n## Goals\n\n#### Detail\n\n## Goals', onOutline)

    expect(screen.getAllByRole('heading').map((heading) => heading.id)).toStrictEqual(['h-plan', 'h-goals', 'h-detail', 'h-goals-1'])
    expect(onOutline).toHaveBeenLastCalledWith([
      { id: 'h-plan', level: 1, text: 'Plan' }, { id: 'h-goals', level: 2, text: 'Goals' }, { id: 'h-goals-1', level: 2, text: 'Goals' },
    ])
  })

  it('shows a footnote, a definition and raw HTML as their source', () => {
    const { container } = renderRead('Text[^1] <b>bold</b>\n\n[^1]: The note.')

    expect([...container.querySelectorAll('.canvas-raw-inline, .canvas-raw')].map((node) => node.textContent))
      .toStrictEqual(['[^1]', '<b>', '</b>', '[^1]: The note.'])
    expect(container.querySelector('b')).toBeNull()
  })

  it('parses a large text once per version, however often the page around it renders', async () => {
    const user = userEvent.setup()
    const parses = vi.mocked(remarkParity)
    parses.mockClear()
    function Page() {
      const [version, setVersion] = useState(1)
      const [, setTick] = useState(0)
      return (
        <MemoryRouter>
          <button type="button" onClick={() => setTick((tick) => tick + 1)}>Render</button>
          <button type="button" onClick={() => setVersion(2)}>Next version</button>
          <MarkdownRead source={`${LARGE}\n\nVersion ${String(version)}`} policy={markdownPolicy.stored} />
        </MemoryRouter>
      )
    }
    render(<Page />)
    await user.click(screen.getByRole('button', { name: 'Render' }))
    await user.click(screen.getByRole('button', { name: 'Render' }))
    const sameVersion = parses.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Next version' }))

    expect([sameVersion, parses.mock.calls.length]).toStrictEqual([1, 2])
  })
})
