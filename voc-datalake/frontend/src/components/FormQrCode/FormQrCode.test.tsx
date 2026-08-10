/**
 * Tests for the feedback-form QR.
 *
 * The encoder is wrapped rather than replaced: the real library still renders,
 * so the assertions run against a genuine SVG, while the wrapper records what it
 * was asked to encode. Nothing in a rendered QR reveals its payload, and that is
 * exactly the property that has to be guarded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentProps } from 'react'

const spy = vi.hoisted(() => ({
  encoded: new Array<{
    value: string | string[]
    size?: number
    marginSize?: number
  }>(),
}))

vi.mock('qrcode.react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('qrcode.react')>()
  const Real = actual.QRCodeSVG
  return {
    ...actual,
    QRCodeSVG: (props: ComponentProps<typeof Real>) => {
      spy.encoded.push({ value: props.value, size: props.size, marginSize: props.marginSize })
      return <Real {...props} />
    },
  }
})

import FormQrCode from './FormQrCode'

const { t } = i18n

function renderQr(formId = 'form_1') {
  return render(
    <FormQrCode apiEndpoint="https://api.example.com" formId={formId} formName="Website Feedback" />,
  )
}

/** The QR, found the way assistive technology finds it. */
function findQr(): HTMLElement {
  return screen.getByRole('img', {
    name: t('components:formQrCode.accessibleName', { formName: 'Website Feedback' }),
  })
}

describe('a feedback form QR', () => {
  beforeEach(() => {
    spy.encoded.length = 0
  })

  it('renders an inline SVG QR named for the form it opens', () => {
    renderQr()

    const qr = findQr()
    // Inline SVG, not a canvas and not a remote image: crisp when projected, and
    // no form URL leaves the browser to be rendered by someone else.
    expect(qr.tagName.toLowerCase()).toBe('svg')
    // Background plus the module path — an SVG frame with nothing drawn in it
    // would still satisfy the role query above.
    expect(qr.querySelectorAll('path').length).toBeGreaterThan(1)
    expect(screen.getByText(t('components:formQrCode.caption'))).toBeInTheDocument()
  })

  it('encodes the form\'s own hosted public page', () => {
    renderQr()

    expect(spy.encoded).toHaveLength(1)
    expect(spy.encoded[0].value).toBe('https://api.example.com/feedback-forms/form_1/iframe')
  })

  it('points a different form\'s QR at that form', () => {
    renderQr('form_42')

    expect(spy.encoded[0].value).toBe('https://api.example.com/feedback-forms/form_42/iframe')
  })

  it('renders large enough, with the quiet zone, to scan from across a room', () => {
    renderQr()

    // Both are scan requirements rather than styling: below roughly 200px a
    // phone a few metres from a projector cannot resolve the modules, and the
    // library defaults the quiet zone to 0 modules, which leaves a scanner
    // unable to find the symbol's edges against a busy card.
    expect(spy.encoded[0].size).toBeGreaterThanOrEqual(200)
    expect(spy.encoded[0].marginSize).toBeGreaterThanOrEqual(4)
  })
})
