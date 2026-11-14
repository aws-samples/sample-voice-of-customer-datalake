/**
 * The walkthrough's frame messages (docs/prototype-builder.md Part 1) are checked before the page acts on them:
 * only the contract's shapes pass; anything else, the pin widget's messages included, is nothing.
 */
import { describe, expect, it } from 'vitest'
import { parseWalkthroughMessage } from './walkthroughMessages'

describe('parseWalkthroughMessage', () => {
  it.each([
    { type: 'voc-walkthrough', event: 'ready', steps: 3 },
    { type: 'voc-walkthrough', event: 'dont-show-again' },
    { type: 'voc-walkthrough', event: 'picked', selector: '#a', anchor: { route: '', bbox: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
    { type: 'voc-walkthrough', event: 'pick-cancelled' },
  ])('accepts %o', (message) => {
    expect(parseWalkthroughMessage(message)).not.toBeNull()
  })

  it.each([
    { type: 'voc-walkthrough', event: 'ready', steps: 11 },
    { type: 'voc-walkthrough', event: 'write-to-server' },
    { type: 'voc-walkthrough', event: 'started' },
    { type: 'voc-walkthrough', event: 'picked', anchor: { route: '', bbox: { x: 2, y: 0, w: 0, h: 0 } } },
    { source: 'voc-pin-widget', type: 'ready', formId: 'pf_0123456789abcdef' },
    null,
  ])('refuses %o', (message) => {
    expect(parseWalkthroughMessage(message)).toBeNull()
  })
})
