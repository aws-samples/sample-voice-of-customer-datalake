import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
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

  it('opens external https links in a new tab without opener, referrer or follow, showing the hostname', () => {
    renderAnswer('See [the report](https://example.com/report?x=1).')
    const link = screen.getByRole('link', { name: /the report/ })
    expect({
      href: link.getAttribute('href'),
      target: link.getAttribute('target'),
      rel: link.getAttribute('rel'),
      title: link.getAttribute('title'),
    }).toStrictEqual({ href: 'https://example.com/report?x=1', target: '_blank', rel: 'noopener noreferrer nofollow', title: 'example.com' })
    expect(link).toHaveTextContent('(example.com)')
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
})
