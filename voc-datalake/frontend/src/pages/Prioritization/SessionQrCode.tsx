/**
 * @fileoverview A voting session's ballot page as a scannable QR code.
 *
 * A sibling of `components/FormQrCode`, not a reuse of it: that component encodes
 * a FEEDBACK FORM's public page (`/feedback-forms/{id}/iframe` on the API host)
 * and takes a form id. This encodes a BALLOT page (`/vote/{sessionId}` on the
 * app's own origin) and takes a session token. Pointing the room at the customer
 * form's public page is exactly the confusion the issue warns against, and a
 * component that took "an id and a kind" would make that mistake expressible.
 *
 * Everything else follows the same reasoning, which is recorded there in full:
 * inline SVG (crisp when projected, no URL sent to a third-party image service, no
 * hand-rolled Reed–Solomon), a quiet zone the library does not add by default, and
 * error correction sized for glare and heads rather than a pristine scan.
 *
 * And the same refusal: a QR cannot report its own failure — whatever it encodes,
 * it looks like a QR and scans like one — so an origin no phone can reach is said
 * in words instead of drawn.
 *
 * @module pages/Prioritization/SessionQrCode
 */
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { ballotPageUrl } from '../../api/ballotPageUrl'
import type { ReactElement } from 'react'

/** Intrinsic edge in CSS pixels, and the widest this is drawn. Sized for a phone
 *  a few metres from a projector; `w-full h-auto` lets a narrower container scale
 *  it down losslessly via the SVG's viewBox. */
const QR_SIZE_PX = 384

/** The specification's 4-module quiet zone, which the library defaults to 0.
 *  Without it a scanner cannot find the symbol's edges against a slide. */
const QR_MARGIN_MODULES = 4

/** ~15% recoverable. The realistic failure is glare and heads in the way. */
const QR_ERROR_CORRECTION = 'M'

/**
 * @param sessionId the session token the room scans. It is the whole of what the
 *   QR carries, and the only thing that makes the ballot route usable.
 * @param rowTitle names the QR for assistive technology — a facilitator's
 *   screen reader should say which proposal this opens a vote on.
 */
export default function SessionQrCode({
  sessionId, rowTitle,
}: {
  readonly sessionId: string
  readonly rowTitle: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  // The app's own origin, because the ballot page is a route of this SPA. Read
  // here rather than threaded as a prop: there is one browser and one origin, and
  // a prop would invite a caller to pass the API endpoint — which is a different
  // host, on which `/vote/x` is a 403.
  const url = ballotPageUrl(window.location.origin, sessionId)
  if (url === null) {
    return <p className="text-sm text-indigo-800">{t('roomVote.qrUnavailable')}</p>
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <QRCodeSVG
        value={url}
        size={QR_SIZE_PX}
        level={QR_ERROR_CORRECTION}
        marginSize={QR_MARGIN_MODULES}
        // Becomes the SVG's <title>, which is what assistive tech announces for
        // its role="img".
        title={t('roomVote.qrAccessibleName', { title: rowTitle })}
        className="bg-white w-full h-auto"
      />
      {/* The address in text under the symbol: a phone whose camera will not
          focus, or a remote attendee on a video call, still needs a way in. */}
      <p className="text-xs text-indigo-800 text-center break-all">{url}</p>
      <p className="text-xs text-indigo-800 text-center">{t('roomVote.qrCaption')}</p>
    </div>
  )
}
