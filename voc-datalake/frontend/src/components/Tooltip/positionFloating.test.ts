/**
 * positionFloating: the side asked for, flipped when there is no room, shifted to stay 8 px inside the
 * viewport, `start` / `end` by reading direction. jsdom lays nothing out, so the viewport, the trigger's box
 * and the bubble's size are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLOATING_GAP_PX, VIEWPORT_MARGIN_PX, physicalSide, positionFloating } from './positionFloating'

const VIEWPORT = { width: 1000, height: 800 }
const BUBBLE = { width: 120, height: 30 }
const TRIGGER = { width: 40, height: 20 }

function stubSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'offsetWidth', { configurable: true, value: width })
  Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height })
  element.style.width = `${width}px`
  element.style.height = `${height}px`
}

/** A trigger whose box starts at (`x`, `y`) and a bubble, both in the document. */
function place(x: number, y: number): { trigger: HTMLElement; bubble: HTMLElement } {
  const trigger = document.createElement('button')
  stubSize(trigger, TRIGGER.width, TRIGGER.height)
  trigger.getBoundingClientRect = () => new DOMRect(x, y, TRIGGER.width, TRIGGER.height)
  const bubble = document.createElement('div')
  bubble.style.position = 'fixed'
  stubSize(bubble, BUBBLE.width, BUBBLE.height)
  document.body.append(trigger, bubble)
  return { trigger, bubble }
}

beforeEach(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: VIEWPORT.height })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('positionFloating', () => {
  it('puts the bubble on the side asked for, centred on the trigger, the gap away', async () => {
    const { trigger, bubble } = place(400, 400)
    const side = await positionFloating(trigger, bubble, 'top')
    expect(side).toBe('top')
    expect(bubble.style.top).toBe(`${400 - FLOATING_GAP_PX - BUBBLE.height}px`)
    expect(bubble.style.left).toBe(`${400 + TRIGGER.width / 2 - BUBBLE.width / 2}px`)
    expect(bubble.dataset.placement).toBe('top')
  })

  it('flips to the other side when there is no room', async () => {
    const { trigger, bubble } = place(400, 10)
    const side = await positionFloating(trigger, bubble, 'top')
    expect(side).toBe('bottom')
    expect(bubble.style.top).toBe(`${10 + TRIGGER.height + FLOATING_GAP_PX}px`)
  })

  it('shifts along the side to stay inside the viewport', async () => {
    const atStart = place(0, 400)
    const atEnd = place(VIEWPORT.width - TRIGGER.width, 400)
    await positionFloating(atStart.trigger, atStart.bubble, 'top')
    await positionFloating(atEnd.trigger, atEnd.bubble, 'bottom')
    expect(atStart.bubble.style.left).toBe(`${VIEWPORT_MARGIN_PX}px`)
    expect(atEnd.bubble.style.left).toBe(`${VIEWPORT.width - VIEWPORT_MARGIN_PX - BUBBLE.width}px`)
  })
})

describe('physicalSide', () => {
  it.each([
    ['start', false, 'left'],
    ['end', false, 'right'],
    ['start', true, 'right'],
    ['end', true, 'left'],
    ['top', true, 'top'],
    ['bottom', false, 'bottom'],
  ] as const)('%s (rtl %s) is %s', (placement, rtl, side) => {
    expect(physicalSide(placement, rtl)).toBe(side)
  })
})
