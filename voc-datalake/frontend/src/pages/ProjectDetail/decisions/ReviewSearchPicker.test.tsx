/**
 * The decision form asked people to type "Feedback ids". They now search for the
 * reviews (`GET /feedback/search`, debounced, 2+ characters) and pick them; the ids
 * still travel in the draft, and pasting ids stays possible under "Advanced".
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { renderWithQueryClient } from '@test/query-client'
import ReviewSearchPicker from './ReviewSearchPicker'

const searchFeedback = vi.hoisted(() => vi.fn())
vi.mock('../../../api/client', () => ({ api: { searchFeedback } }))

const review = (id: string, text: string, title?: string) => ({ feedback_id: id, original_text: text, title })

function Harness({ initial = '', onChange }: Readonly<{ initial?: string; onChange: (value: string) => void }>) {
  const [value, setValue] = useState(initial)
  return <ReviewSearchPicker value={value} onChange={(next) => { setValue(next); onChange(next) }} />
}

beforeEach(() => {
  searchFeedback.mockReset().mockResolvedValue({ count: 2, items: [review('fb_1', 'The parcel arrived late again', 'Late parcel'), review('fb_2', 'Courier lost my order')] })
})

describe('ReviewSearchPicker', () => {
  it('finds reviews by words and adds the picked one as a named chip', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithQueryClient(<Harness onChange={onChange} />)
    await user.type(screen.getByRole('searchbox', { name: 'Supporting reviews' }), 'late')
    await user.click(await screen.findByRole('button', { name: 'Late parcel' }))
    expect(onChange).toHaveBeenLastCalledWith('fb_1')
    expect(screen.getByRole('list', { name: 'Reviews you added' })).toHaveTextContent('Late parcel')
  })

  it('searches once per typed query and never for a single character', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<Harness onChange={vi.fn()} />)
    await user.type(screen.getByRole('searchbox'), 'l')
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    expect(searchFeedback).not.toHaveBeenCalled()
    await user.type(screen.getByRole('searchbox'), 'ate')
    await waitFor(() => expect(searchFeedback).toHaveBeenCalledTimes(1))
    expect(searchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'late' }))
  })

  it('removes a review, and keeps prefilled ids (from a link) as linked reviews', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithQueryClient(<Harness initial="fb_7 fb_8" onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Remove Linked review 1' }))
    expect(onChange).toHaveBeenLastCalledWith('fb_8')
  })
})
