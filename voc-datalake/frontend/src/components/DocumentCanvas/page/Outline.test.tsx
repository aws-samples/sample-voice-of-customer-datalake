import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Outline from './Outline'
import type { OutlineItem } from '../editor/CanvasEditor'

const ITEMS: readonly OutlineItem[] = [
  { id: 'overview', level: 1, text: 'Overview' },
  { id: 'goals', level: 2, text: 'Goals' },
  { id: 'metrics', level: 3, text: 'Metrics' },
]

/** An IntersectionObserver the test drives: `emit` reports which headings entered or left the viewport. */
class DrivenObserver implements IntersectionObserver {
  static readonly live: DrivenObserver[] = []
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds: readonly number[] = []
  private readonly targets: Element[] = []
  private readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    DrivenObserver.live.push(this)
  }
  observe(target: Element) { this.targets.push(target) }
  unobserve(target: Element) { this.targets.splice(this.targets.indexOf(target), 1) }
  disconnect() { this.targets.splice(0) }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  report(changes: Readonly<Record<string, boolean>>) {
    const entries = this.targets.filter((target) => target.id in changes).map((target): IntersectionObserverEntry => {
      const rect = target.getBoundingClientRect()
      return {
        target, isIntersecting: changes[target.id] === true, boundingClientRect: rect, intersectionRect: rect,
        intersectionRatio: 0, rootBounds: null, time: 0,
      }
    })
    this.callback(entries, this)
  }
}

const emit = (changes: Readonly<Record<string, boolean>>) => {
  act(() => { for (const observer of DrivenObserver.live) observer.report(changes) })
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', DrivenObserver)
  for (const item of ITEMS) {
    const heading = document.createElement('h2')
    heading.id = item.id
    document.body.append(heading)
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  DrivenObserver.live.splice(0)
  for (const item of ITEMS) document.getElementById(item.id)?.remove()
})

const links = () => within(screen.getByRole('navigation', { name: 'Contents' })).getAllByRole('link')
const link = (name: string) => screen.getByRole('link', { name })

/** Renders the outline and opens its narrow-screen "Contents" disclosure. */
async function openDisclosure() {
  const user = userEvent.setup()
  render(<Outline items={ITEMS} onNavigate={vi.fn()} />)
  const toggle = screen.getByRole('button', { name: 'Contents' })
  await user.click(toggle)
  return { user, toggle }
}

describe('Outline', () => {
  it('lists the h1-h3 headings as links in a "Contents" landmark', () => {
    render(<Outline items={ITEMS} onNavigate={vi.fn()} />)
    expect(links().map((element) => element.textContent)).toStrictEqual(['Overview', 'Goals', 'Metrics'])
    expect(links().map((element) => element.getAttribute('href'))).toStrictEqual(['#overview', '#goals', '#metrics'])
  })

  it('indents each level', () => {
    render(<Outline items={ITEMS} onNavigate={vi.fn()} />)
    expect(link('Overview')).toHaveClass('pl-2')
    expect(link('Metrics')).toHaveClass('pl-8')
  })

  it('renders nothing for a document without headings', () => {
    const { container } = render(<Outline items={[]} onNavigate={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks the heading being read while the page scrolls', () => {
    render(<Outline items={ITEMS} onNavigate={vi.fn()} />)
    expect(link('Overview')).toHaveAttribute('aria-current', 'location')
    emit({ overview: false, goals: true })
    expect(link('Goals')).toHaveAttribute('aria-current', 'location')
    expect(link('Overview')).not.toHaveAttribute('aria-current')
  })

  it('keeps the last heading read marked once every heading in view has scrolled past', () => {
    render(<Outline items={ITEMS} onNavigate={vi.fn()} />)
    emit({ overview: false, goals: true })
    emit({ goals: false })
    expect(link('Goals')).toHaveAttribute('aria-current', 'location')
  })

  it('scrolls the canvas to a heading on click, and marks it', async () => {
    const onNavigate = vi.fn()
    render(<Outline items={ITEMS} onNavigate={onNavigate} />)
    await userEvent.setup().click(link('Metrics'))
    expect(onNavigate).toHaveBeenLastCalledWith('metrics')
    expect(link('Metrics')).toHaveAttribute('aria-current', 'location')
  })

  it('follows a heading with Enter', async () => {
    const onNavigate = vi.fn()
    render(<Outline items={ITEMS} onNavigate={onNavigate} />)
    link('Goals').focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(onNavigate).toHaveBeenLastCalledWith('goals')
  })

  it('is a collapsed "Contents" disclosure on narrow screens that opens on click', async () => {
    render(<Outline items={ITEMS} onNavigate={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Contents' })
    const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(list).toHaveClass('hidden', 'lg:block')
    await userEvent.setup().click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(list).not.toHaveClass('hidden')
  })

  it('closes the disclosure on Escape and gives the focus back to its button', async () => {
    const { user, toggle } = await openDisclosure()
    link('Goals').focus()
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
  })

  it('closes the disclosure once a heading is chosen', async () => {
    const { user, toggle } = await openDisclosure()
    await user.click(link('Goals'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
