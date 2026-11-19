/**
 * widgetAssetPlugin (vite.config.ts): the build emits the one widget source as `widget/feedback-widget.js` with a
 * banner naming the release, and the dev server answers `/widget/feedback-widget.js` with the file as it is on disk.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { WIDGET_FILE_NAME, WIDGET_SOURCE, serveWidget, widgetAssetPlugin, widgetBanner } from '../../widgetAssetPlugin.ts'

const OPTIONS = { version: '7.55.01', commit: 'abc1234' }

interface Answer {
  status: number
  headers: Record<string, string>
  body: string | undefined
  passed: boolean
}

/** Ask the dev middleware for `url` with `method`, as the dev server would. */
function ask(url: string, method = 'GET'): Answer {
  const answer: Answer = { status: 0, headers: {}, body: undefined, passed: false }
  const res = {
    set statusCode(value: number) { answer.status = value },
    setHeader(name: string, value: string) { answer.headers[name.toLowerCase()] = value },
    end(body?: string) { answer.body = body },
  }
  const req: Pick<IncomingMessage, 'url' | 'method'> = { url, method }
  Reflect.apply(serveWidget(OPTIONS), undefined, [req, res, () => { answer.passed = true }])
  return answer
}

/** Run the plugin's generateBundle hook with `emitFile`. */
function generateBundle(emitFile: (file: unknown) => void): void {
  const hook = widgetAssetPlugin(OPTIONS).generateBundle
  if (typeof hook !== 'function') throw new Error('generateBundle is not a function hook')
  Reflect.apply(hook, { emitFile }, [{}, {}, false])
}

describe('widgetAssetPlugin', () => {
  it('names the release in the banner', () => {
    expect(widgetBanner(OPTIONS)).toBe(
      '/*! VoC feedback widget 7.55.01 (abc1234), served at /widget/feedback-widget.js. See docs/feedback-forms.md. */\n')
  })

  it('emits the widget source, under its banner, as widget/feedback-widget.js in the build', () => {
    const emitFile = vi.fn()
    generateBundle(emitFile)
    expect(emitFile).toHaveBeenCalledWith({
      type: 'asset', fileName: WIDGET_FILE_NAME, source: widgetBanner(OPTIONS) + readFileSync(WIDGET_SOURCE, 'utf8'),
    })
    expect(WIDGET_FILE_NAME).toBe('widget/feedback-widget.js')
  })

  it('serves the file on disk in dev, as JavaScript, revalidated, CORS-open and nosniff', () => {
    const answer = ask('/widget/feedback-widget.js?v=1')
    expect(answer).toMatchObject({ status: 200, passed: false, body: widgetBanner(OPTIONS) + readFileSync(WIDGET_SOURCE, 'utf8') })
    expect(answer.headers).toStrictEqual({
      'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    })
  })

  it('answers HEAD without a body, and leaves every other request to the next middleware', () => {
    expect(ask('/widget/feedback-widget.js', 'HEAD')).toMatchObject({ status: 200, body: undefined, passed: false })
    expect(ask('/widget/feedback-widget.js', 'POST').passed).toBe(true)
    expect(ask('/widget/other.js').passed).toBe(true)
    expect(ask('/feedback-forms').passed).toBe(true)
  })
})
