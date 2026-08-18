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
    level?: string
  }>(),
}))

vi.mock('qrcode.react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('qrcode.react')>()
  const Real = actual.QRCodeSVG
  return {
    ...actual,
    QRCodeSVG: (props: ComponentProps<typeof Real>) => {
      spy.encoded.push({
        value: props.value, size: props.size, marginSize: props.marginSize, level: props.level,
      })
      return <Real {...props} />
    },
  }
})

import FormQrCode from './FormQrCode'

const { t } = i18n

function renderQr(formId = 'form_1', apiEndpoint = 'https://api.example.com') {
  return render(
    <FormQrCode apiEndpoint={apiEndpoint} formId={formId} formName="Website Feedback" />,
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

  it('renders large enough, with the quiet zone and the error correction, to scan from across a room', () => {
    renderQr()

    // All three are scan requirements rather than styling: below roughly 200px a
    // phone a few metres from a projector cannot resolve the modules, the
    // library defaults the quiet zone to 0 modules, which leaves a scanner
    // unable to find the symbol's edges against a busy card, and 'M' is what
    // recovers a symbol partly lost to glare or a head in the way. Dropping to
    // the library's cheaper 'L' would still render a valid QR — and fail in the
    // room, which is the only place anyone would find out.
    expect(spy.encoded[0].size).toBeGreaterThanOrEqual(200)
    expect(spy.encoded[0].marginSize).toBeGreaterThanOrEqual(4)
    expect(spy.encoded[0].level).toBe('M')
  })

  it('fills the width it is given rather than rendering at a fixed small size', () => {
    renderQr()

    // The floor above is the scan MINIMUM; this is what makes the symbol as large
    // as the dialog actually allows. Without `w-full` the SVG draws at whatever
    // `size` says and stops there, so widening the dialog would leave the QR
    // rattling around inside it — the exact complaint that prompted this. `h-auto`
    // keeps it square, which is safe because `QRCodeSVG` emits a viewBox.
    const qr = findQr()
    expect(qr).toHaveClass('w-full')
    expect(qr).toHaveClass('h-auto')
    // And it is fed a generous intrinsic size, so scaling is a cap rather than a
    // stretch: a symbol drawn at 200 and blown up to 384 is soft at the edges.
    expect(spy.encoded[0].size).toBeGreaterThanOrEqual(320)
  })

  it('says so in words instead of encoding an address that resolves nowhere', () => {
    // No endpoint configured. The alternative is a flawless, scannable symbol
    // for '/feedback-forms/form_1/iframe' — which a phone cannot resolve, and
    // which looks exactly like a working QR to everyone in the room.
    renderQr('form_1', '')

    expect(spy.encoded).toHaveLength(0)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText(t('components:formQrCode.unavailable'))).toBeInTheDocument()
  })

  it('encodes nothing for an endpoint that is not an absolute address', () => {
    // '/api' is the relative base the app itself fetches against quite happily.
    renderQr('form_1', '/api')

    expect(spy.encoded).toHaveLength(0)
    expect(screen.getByText(t('components:formQrCode.unavailable'))).toBeInTheDocument()
  })
})
