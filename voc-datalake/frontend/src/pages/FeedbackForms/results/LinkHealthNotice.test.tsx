/**
 * The link checks: a warning per hidden field the links never fill (5 responses or more) or mostly leave
 * empty (80 % of 10 or more), with the parameter that fills it and where the responses without it came from; nothing
 * without a warning, or from a server that checks no links.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/test-utils'
import type { LinkHealth } from '../../../api/feedbackFormsV2Results'
import { LINK_HEALTH as HEALTH } from './results-fixtures'
import LinkHealthNotice from './LinkHealthNotice'

const fill = (filled: number, missing: number) => ({ filled, missing })

describe('LinkHealthNotice', () => {
  it('says a hidden field no link filled, with its parameter and the channels without it, most first', () => {
    render(<LinkHealthNotice health={HEALTH} />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('Check your links')
    expect(note).toHaveTextContent('0 of 26 responses had customer: check your link.')
    expect(note).toHaveTextContent('A link fills it with hf_customer=. Missing from: Link 18 · Embedded 8.')
  })

  it('says a hidden field most responses lacked, by its channel, and offers its action', async () => {
    const onClick = vi.fn<() => void>()
    const health: LinkHealth = { ...HEALTH, by_channel: { script: { responses: 12, hidden: { event: fill(1, 11) } }, other: { responses: 1, hidden: { event: fill(0, 1) } } },
      warnings: [{ id: 'event', kind: 'mostly_missing', filled: 1, total: 13 }] }
    render(<LinkHealthNotice health={health} action={{ label: 'Open Share', onClick }} />)
    expect(screen.getByRole('note')).toHaveTextContent('Only 1 of 13 responses had event: check your link.A link fills it with hf_event=. Missing from: Website script 11 · Unknown 1.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Share' }))
    expect(onClick).toHaveBeenCalledWith()
  })

  it('says nothing without a warning, or without link checks', () => {
    const { container } = render(<><LinkHealthNotice health={{ ...HEALTH, warnings: [] }} /><LinkHealthNotice health={null} /></>)
    expect(container).toBeEmptyDOMElement()
  })
})
