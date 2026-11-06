/**
 * @fileoverview The one way the app shows a QR code (the feedback-form share dialog and the
 * Prioritization room vote): `qrSymbol.ts`'s size, quiet zone and error correction, fluid width,
 * with the caller's captions under it. Callers build the URL (or decide there is none) and the
 * words; this only draws, so the two panels scan alike.
 * @module components/FormQrCode/QrPanel
 */
import { QRCodeSVG } from 'qrcode.react'
import type { ReactElement, ReactNode } from 'react'
import { QR_ERROR_CORRECTION, QR_MARGIN_MODULES, QR_SIZE_PX } from './qrSymbol'

/**
 * @param url the address the symbol encodes; null = there is none, and `unavailable` is shown instead
 *   (a QR cannot report its own failure, so a dead address is said in words, never drawn).
 * @param title becomes the SVG's <title>, which is what assistive tech announces for its role="img"
 *   (an unnamed QR is an unlabelled image).
 * @param unavailable what to show when `url` is null.
 * @param children the captions under the symbol.
 */
export default function QrPanel({ url, title, unavailable, children }: {
  readonly url: string | null
  readonly title: string
  readonly unavailable: ReactNode
  readonly children: ReactNode
}): ReactElement {
  if (url === null) return <>{unavailable}</>
  return (
    <div className="flex flex-col items-center gap-2">
      <QRCodeSVG
        value={url}
        size={QR_SIZE_PX}
        level={QR_ERROR_CORRECTION}
        marginSize={QR_MARGIN_MODULES}
        title={title}
        // Fluid up to QR_SIZE_PX rather than fixed at it: `w-full` lets a narrow
        // container (a phone in portrait) scale the symbol down instead of
        // overflowing the dialog, and `h-auto` keeps it square via the viewBox.
        className="bg-white w-full h-auto"
      />
      {children}
    </div>
  )
}
