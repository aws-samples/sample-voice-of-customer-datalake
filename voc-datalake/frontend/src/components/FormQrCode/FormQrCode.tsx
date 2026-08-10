/**
 * @fileoverview A feedback form's public page as a scannable QR code.
 *
 * Exists for the room: getting a group's ratings in otherwise means reading a
 * URL aloud or pasting it into a chat channel, while a QR on the screen is
 * scanned off a projector. Rendered on the form's own card and on the
 * prioritization row of the document that form validates — one component, so the
 * two never diverge.
 *
 * Takes the endpoint and the form id, NOT a URL: `feedbackFormPublicUrl` is the
 * only place a form's public address is built, and accepting a ready-made string
 * would invite a second construction site whose drift nothing on screen reveals.
 * It also decides when there is no address to encode at all, which is why this
 * component has a second thing it can render: an endpoint that resolves nowhere
 * would otherwise produce a flawless, scannable symbol for an address that does
 * not exist, and no viewer could tell. Saying so is the whole guard — a room
 * pointing phones at a dead QR gets no error message.
 *
 * Encoded in the browser as SVG. Crisp when projected (a canvas at these sizes
 * is not), no third-party image service — that would ship form URLs to an
 * external endpoint for no benefit and fail in a room with poor connectivity —
 * and no hand-rolled encoder, because Reed–Solomon error correction is not a
 * place to be clever.
 *
 * @module components/FormQrCode
 */
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { feedbackFormPublicUrl } from '../../api/feedbackFormUrls'
import type { ReactElement } from 'react'

/**
 * Rendered edge, in CSS pixels.
 *
 * A phone camera a few metres from a projected screen needs roughly this much
 * before it resolves the modules, which is the entire point of the feature — a
 * QR too small to scan from a seat is decoration.
 */
const QR_SIZE_PX = 200

/**
 * Quiet zone, in modules. The QR specification requires 4, and the library
 * defaults to 0: without it a scanner cannot find the symbol's edges against a
 * busy card or slide.
 */
const QR_MARGIN_MODULES = 4

/**
 * Error correction level. `M` recovers ~15% of a damaged or partly obscured
 * symbol — the realistic failure mode here is glare and heads in the way, not a
 * pristine scan — and costs only a slightly denser grid at this URL length.
 */
const QR_ERROR_CORRECTION = 'M'

/**
 * The QR for one feedback form's public page.
 *
 * @param apiEndpoint the configured API base.
 * @param formId the form whose public page the QR opens.
 * @param formName the form's display name, used to name the QR for assistive
 *   technology — a page can show several.
 */
export default function FormQrCode({
  apiEndpoint, formId, formName,
}: {
  readonly apiEndpoint: string
  readonly formId: string
  readonly formName: string
}): ReactElement {
  const { t } = useTranslation('components')
  const url = feedbackFormPublicUrl(apiEndpoint, formId)
  // A QR cannot report its own failure: whatever it encodes, it looks like a QR
  // and scans like one, so an unusable endpoint would reach the room as a symbol
  // that resolves to nothing. `feedbackFormPublicUrl` decides — the only thing
  // left to do here is say it in words rather than draw it.
  if (url === null) {
    return <p className="text-xs text-gray-500 text-center">{t('formQrCode.unavailable')}</p>
  }
  return (
    <div className="flex flex-col items-center gap-2">
      {/* `title` becomes the SVG's <title>, which is what assistive tech
          announces for its role="img" — an unnamed QR is an unlabelled image. */}
      <QRCodeSVG
        value={url}
        size={QR_SIZE_PX}
        level={QR_ERROR_CORRECTION}
        marginSize={QR_MARGIN_MODULES}
        title={t('formQrCode.accessibleName', { formName })}
        className="bg-white"
      />
      <p className="text-xs text-gray-500 text-center">{t('formQrCode.caption')}</p>
    </div>
  )
}
