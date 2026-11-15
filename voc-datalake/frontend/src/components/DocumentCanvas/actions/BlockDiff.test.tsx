/**
 * The assistant's proposed text is the model's, not yet approved: the diff renders it as the
 * assistant renders its answers, so an image in it is never fetched and an unsafe link is text.
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { MAX_DIFF_CHARS } from '../../../assistant/approvals/lineDiff'
import BlockDiff from './BlockDiff'

const UNSAFE = '![pixel](https://tracker.example/p.gif)\n\n[open me](javascript:alert(1))'

function renderDiff(before: string, after: string) {
  return render(<MemoryRouter><BlockDiff before={before} after={after} /></MemoryRouter>)
}

/** No image, and the javascript: link is plain text (no anchor at all, not even one with an emptied href). */
function expectNothingLive(container: HTMLElement) {
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('a')).toBeNull()
  expect(container).toHaveTextContent('open me')
}

describe('BlockDiff', () => {
  it('renders no image and no javascript: link from the proposed blocks', () => {
    const { container } = renderDiff('# Plan', `# Plan\n\n${UNSAFE}`)

    expect(container.querySelector('[data-diff="add"]')).not.toBeNull()
    expectNothingLive(container)
  })

  it('renders no image and no javascript: link from a proposal too large to diff', () => {
    const { container } = renderDiff('# Plan', `${UNSAFE}\n\n${'a'.repeat(MAX_DIFF_CHARS + 1)}`)

    expect(container.querySelector('[data-diff]')).toBeNull()
    expectNothingLive(container)
  })

  it('keeps a safe link working', () => {
    const { getByRole } = renderDiff('# Plan', '# Plan\n\n[the guide](https://docs.example/guide)')

    expect(getByRole('link', { name: /the guide/u })).toHaveAttribute('href', 'https://docs.example/guide')
  })
})
