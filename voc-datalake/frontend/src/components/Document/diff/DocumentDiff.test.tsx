/**
 * DocumentDiff, the one compare look: rendered blocks by default (Added / Removed said, not only coloured), the
 * Source line diff one press away, the caller's words when nothing changed.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import DocumentDiff from './DocumentDiff'
import { markdownPolicy } from '../read/markdownPolicy'

function renderDiff(before: string, after: string) {
  return render(
    <MemoryRouter>
      <DocumentDiff before={before} after={after} policy={markdownPolicy.stored} identicalText="Same as the current one."
        beforeLabel="v1" afterLabel="Current" />
    </MemoryRouter>,
  )
}

describe('DocumentDiff', () => {
  it('shows the changed blocks rendered first, each said to be added or removed', () => {
    const { container } = renderDiff('# Plan\n\nShip **Monday**.', '# Plan\n\nShip **Tuesday**.')

    expect(screen.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')
    expect([...container.querySelectorAll('[data-diff="add"], [data-diff="del"]')].map((block) => block.textContent))
      .toStrictEqual(['Removed: Ship Monday.', 'Added: Ship Tuesday.'])
    expect(container.querySelector('[data-diff="add"] strong')).toHaveTextContent('Tuesday')
  })

  it('shows the line diff under Source', async () => {
    const user = userEvent.setup()
    renderDiff('a\nb', 'a\nc')

    await user.click(screen.getByRole('button', { name: 'Source' }))

    expect(screen.getByText('1 lines added, 1 lines removed')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Changes to the document' })).toHaveTextContent('−Removed: b+Added: c')
  })

  it('says the caller\'s words when nothing changed', () => {
    renderDiff('Same.', 'Same.')

    expect(screen.getByText('Same as the current one.')).toBeInTheDocument()
  })
})
