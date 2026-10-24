import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { createThreadState } from '../thread/reducer'
import MessageList from './MessageList'
import { classifyHref } from './safeHref'
import type { Message } from '@ag-ui/core'

function renderAnswer(markdown: string) {
  const messages: Message[] = [{ id: 'a1', role: 'assistant', content: markdown }]
  const thread = { ...createThreadState('t1'), messages }
  return render(<MessageList thread={thread} page={{ kind: 'home', path: '/' }} />)
}

describe('MessageList markdown links', () => {
  // jsdom has no scrollIntoView; the returned teardown removes the stub again.
  beforeEach(() => stubElementScrollIntoView())

  it('opens external https links in a new tab without opener, referrer or follow; the host is in the tooltip, not after the text', () => {
    renderAnswer('See [the report](https://example.com/report?x=1).')
    const link = screen.getByRole('link', { name: /the report/ })
    expect({
      href: link.getAttribute('href'),
      target: link.getAttribute('target'),
      rel: link.getAttribute('rel'),
      title: link.getAttribute('title'),
    }).toStrictEqual({ href: 'https://example.com/report?x=1', target: '_blank', rel: 'noopener noreferrer nofollow', title: 'https://example.com/report?x=1' })
    // Wave 4: no visible "(example.com)" suffix; screen readers still hear where it goes.
    expect(link).not.toHaveTextContent('(example.com)')
    expect(link).toHaveAccessibleName('the report example.com, opens in a new tab')
  })

  it('shows a bare URL as a short host/path, with the full address in the tooltip', () => {
    renderAnswer('Source: https://www.example-air.example/changelog/2026-06-18-agent-assisted-project-updates-and-more')
    const link = screen.getByRole('link', { name: /example-air\.example/ })
    expect([link.firstChild?.textContent, link.getAttribute('title')]).toStrictEqual([
      'example-air.example/changelog/2026-06-18-agent-…',
      'https://www.example-air.example/changelog/2026-06-18-agent-assisted-project-updates-and-more',
    ])
  })

  it('renders in-app paths as client-side links in the same tab', () => {
    renderAnswer('Open [Categories](/categories).')
    const link = screen.getByRole('link', { name: 'Categories' })
    expect(link).toHaveAttribute('href', '/categories')
    expect(link).not.toHaveAttribute('target')
  })

  it('renders protocol-relative, javascript: and data: links as plain text', () => {
    renderAnswer('[a](//evil.example/x) [b](javascript:alert(1)) [c](data:text/html,hi) [d](mailto:x@example.com)')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })

  it('does not render images from model markdown', () => {
    const { container } = renderAnswer('![pixel](https://tracker.example/p.gif)')
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('MessageList thinking state', () => {
  beforeEach(() => stubElementScrollIntoView())

  it('shows the drifting Kiro ghost while streaming before the answer starts', () => {
    const messages: Message[] = [{ id: 'u1', role: 'user', content: 'hi' }]
    render(<MessageList thread={{ ...createThreadState('t1'), messages, status: 'streaming' }} page={{ kind: 'home', path: '/' }} />)
    const row = screen.getByText('Thinking…')
    expect(row.querySelector('svg.animate-float')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows no thinking row once the assistant is answering', () => {
    const messages: Message[] = [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'Hel' }]
    render(<MessageList thread={{ ...createThreadState('t1'), messages, status: 'streaming' }} page={{ kind: 'home', path: '/' }} />)
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
  })
})

describe('classifyHref', () => {
  it('accepts http(s) as external and single-slash paths as in-app', () => {
    expect(classifyHref('http://example.com')).toStrictEqual({ kind: 'external', href: 'http://example.com/', host: 'example.com' })
    expect(classifyHref('/projects/p1')).toStrictEqual({ kind: 'internal', path: '/projects/p1' })
  })

  it.each(['/\\evil.example', 'relative/path', undefined])('treats %s as unsafe', (href) => {
    expect(classifyHref(href)).toStrictEqual({ kind: 'unsafe' })
  })

  it.each([
    ['/feedback/fb_1', 'fb_1'],
    ['/feedback/a%20b?x=1', 'a b'],
    ['/feedback/fb_1/', 'fb_1'],
  ])('turns %s into a review-modal link', (href, feedbackId) => {
    expect(classifyHref(href)).toStrictEqual({ kind: 'review', feedbackId })
  })

  it.each(['/feedback', '/feedback/fb_1/similar', '/feedback/%E0%A4%A'])('keeps %s an ordinary in-app link', (href) => {
    expect(classifyHref(href)).toStrictEqual({ kind: 'internal', path: href })
  })
})

describe('MessageList tool steps (wave 4: one row instead of a wall of chips)', () => {
  beforeEach(() => stubElementScrollIntoView())

  const call = (id: string, name: string) => ({ id, type: 'function' as const, function: { name, arguments: '{}' } })

  function renderTurn(messages: Message[]) {
    return render(<MessageList thread={{ ...createThreadState('t1'), messages }} page={{ kind: 'home', path: '/' }} />)
  }

  it('collapses consecutive tool calls across the model\u2019s turns into one expandable "Looked at N things" row', async () => {
    const user = userEvent.setup()
    renderTurn([
      { id: 'u', role: 'user', content: 'What does Radar show?' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [call('c1', 'get_radar')] },
      { id: 'a2', role: 'assistant', content: '', toolCalls: [call('c2', 'get_radar'), call('c3', 'get_metrics')] },
      { id: 'a3', role: 'assistant', content: 'Here is what Radar shows.', toolCalls: [call('c4', 'suggest_navigation')] },
    ])
    const row = screen.getByRole('button', { name: /Looked at 4 things/u })
    expect([row.getAttribute('aria-expanded'), screen.queryByText('Get radar')]).toStrictEqual(['false', null])
    await user.click(row)
    expect(screen.getAllByRole('listitem').map((chip) => chip.textContent)).toStrictEqual([
      'Get radardone', 'Get radardone', 'Get metricsdone', 'Suggest navigationdone',
    ])
  })

  it('keeps a single tool call as its own chip, and a new question starts a new group', () => {
    renderTurn([
      { id: 'u1', role: 'user', content: 'One' },
      { id: 'a1', role: 'assistant', content: 'Answer one.', toolCalls: [call('c1', 'get_metrics')] },
      { id: 'u2', role: 'user', content: 'Two' },
      { id: 'a2', role: 'assistant', content: 'Answer two.', toolCalls: [call('c2', 'search_feedback')] },
    ])
    expect(screen.queryByRole('button', { name: /Looked at/u })).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((chip) => chip.textContent)).toStrictEqual(['Get metricsdone', 'Search feedbackdone'])
  })
})
