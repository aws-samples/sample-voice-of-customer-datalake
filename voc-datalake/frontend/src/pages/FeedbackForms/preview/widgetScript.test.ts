import { describe, expect, it, vi } from 'vitest'
import { asPreviewHandle, startPreview } from './widgetScript'

function fakeHandle() {
  return { update: vi.fn(), goTo: vi.fn(), restart: vi.fn(), setLanguage: vi.fn(), destroy: vi.fn(), setHiddenFields: vi.fn() }
}

describe('the preview handle of the widget', () => {
  it('drives the widget through the handle init returned', () => {
    const raw = fakeHandle()
    const handle = asPreviewHandle(raw)
    handle?.goTo('q_why')
    handle?.setLanguage('pl')
    expect(raw.goTo).toHaveBeenCalledWith('q_why')
    expect(raw.setLanguage).toHaveBeenCalledWith('pl')
  })

  it('is null for a widget that answers without one (older than 7.55.00)', () => {
    expect(asPreviewHandle(undefined)).toBeNull()
    expect(asPreviewHandle({ setHiddenFields: vi.fn() })).toBeNull()
  })

  it('starts a preview of the draft in the container, in the language asked for', () => {
    const init = vi.fn<(options: Record<string, unknown>) => unknown>(() => fakeHandle())
    const container = document.createElement('div')
    const handle = startPreview({ init }, container, { schema_version: 2 }, 'pl')
    expect(init).toHaveBeenCalledWith({ container, language: 'pl', preview: { config: { schema_version: 2 } } })
    expect(handle).not.toBeNull()
  })
})
