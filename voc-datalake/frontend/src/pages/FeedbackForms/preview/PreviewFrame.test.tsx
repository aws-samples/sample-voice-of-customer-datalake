/**
 * @fileoverview The in-page preview (PreviewFrame): an honest phone (390 px logical, scaled to the room), started with
 * the session seed and a forced palette, driven by commands, updated 150 ms after typing or on the next frame when
 * only the theme changed. The widget itself is a stub (its own specs are feedbackWidget*.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { blankForm } from '../test/blankForm'
import { widget } from '../test/widgetScriptStub'
import { frameSize } from './frameSize'
import PreviewFrame from './PreviewFrame'

vi.mock('./widgetScript', () => import('../test/widgetScriptStub'))

const FORM = blankForm('en')

async function started(): Promise<void> {
  await vi.waitFor(() => expect(widget.startPreview.mock.calls).toHaveLength(1))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the phone the preview lays out in', () => {
  it.each([
    ['fills a pane, never under 320 px', { width: 351, height: 300, top: 0, windowHeight: 900 }, 'fill', { width: 390, height: 333, scale: 0.9 }],
    ['fills a tall pane up to a phone of 844 px', { width: 390, height: 1200, top: 0, windowHeight: 1200 }, 'fill', { width: 390, height: 844, scale: 1 }],
    ['takes what the window leaves under it, at least 480 px', { width: 312, height: 0, top: 400, windowHeight: 800 }, 'window', { width: 390, height: 480, scale: 0.8 }],
    ['keeps a fixed height', { width: 600, height: 0, top: 0, windowHeight: 800 }, 480, { width: 390, height: 480, scale: 1 }],
    ['draws at full size before it is laid out', { width: 0, height: 0, top: 0, windowHeight: 0 }, 'fill', { width: 390, height: 320, scale: 1 }],
  ] as const)('%s', (_what, room, fit, size) => {
    expect(frameSize(room, fit)).toStrictEqual(size)
  })
})

describe('PreviewFrame', () => {
  it('lays the widget out 390 px wide, scaled down to the room, under its accessible name', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(351)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(549)
    const onSize = vi.fn()
    render(<PreviewFrame form={FORM} language="en" title="Form preview, phone size, English" fit="fill" onSize={onSize} />)
    const region = screen.getByRole('region', { name: 'Form preview, phone size, English' })
    expect(region.parentElement).toHaveStyle({ width: '390px', height: '610px', transform: 'scale(0.9)' })
    expect(onSize).toHaveBeenLastCalledWith({ width: 390, height: 610, scale: 0.9 })
    await started()
  })

  it('starts the widget with the session seed and the forced palette, and follows the palette and the commands', async () => {
    const { rerender } = render(<PreviewFrame form={FORM} language="en" title="Preview" seed={42} scheme="dark" />)
    await started()
    expect(widget.startPreview).toHaveBeenCalledWith(expect.anything(), expect.any(HTMLElement), expect.objectContaining({ schema_version: 2 }), 'en', { seed: 42, scheme: 'dark' })
    rerender(<PreviewFrame form={FORM} language="en" title="Preview" seed={42} scheme={null} command={{ kind: 'goTo', target: 'end:end_thanks', nonce: 1 }} />)
    expect(widget.handle.setScheme).toHaveBeenLastCalledWith(null)
    expect(widget.handle.goTo).toHaveBeenCalledExactlyOnceWith('end:end_thanks')
  })

  it('shows an edit 150 ms after typing stops, and a theme-only change on the next frame', async () => {
    const { rerender } = render(<PreviewFrame form={FORM} language="en" title="Preview" />)
    await started()
    vi.useFakeTimers()
    rerender(<PreviewFrame form={{ ...FORM, name: 'Renamed' }} language="en" title="Preview" />)
    vi.advanceTimersByTime(149)
    expect(widget.handle.update).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(widget.handle.update).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Renamed' }))
    const renamed = { ...FORM, name: 'Renamed' }
    rerender(<PreviewFrame form={renamed} language="en" title="Preview" />)
    rerender(<PreviewFrame form={{ ...renamed, theme: { ...renamed.theme, border_radius: '16px' } }} language="en" title="Preview" />)
    vi.advanceTimersToNextFrame()
    const shown: unknown = widget.handle.update.mock.lastCall?.[0]
    expect(shown).toMatchObject({ theme: { border_radius: '16px' } })
  })
})
