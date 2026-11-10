/**
 * Every HTML prototype frame is sandboxed the same way (WA SEC11, EDGE-4): scripts and popups, never forms,
 * same-origin or top navigation. A model-written `<form action="https://…">` in a legacy inline prototype
 * could otherwise post whatever the reader typed to any site.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HtmlPrototypeFrame } from './PrototypeRenderer'

describe('HtmlPrototypeFrame', () => {
  it('sandboxes an inline (legacy) prototype without allow-forms or allow-same-origin', () => {
    render(<HtmlPrototypeFrame html="<form action='https://example.com'></form>" title="Legacy" />)
    const frame = screen.getByTitle('Legacy')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups')
  })
})
