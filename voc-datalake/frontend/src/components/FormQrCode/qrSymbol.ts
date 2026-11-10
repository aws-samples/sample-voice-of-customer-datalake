/**
 * @fileoverview How every QR code of the app is drawn (the feedback-form share
 * dialog and the Prioritization room vote): one symbol rule, so both scan alike.
 * @module components/FormQrCode/qrSymbol
 */

/**
 * Intrinsic edge in CSS pixels, and the widest the symbol is drawn. Sized for a
 * phone a few metres from a projector or a printed card.
 *
 * It is an upper bound rather than a fixed size because `w-full h-auto` lets CSS
 * scale the symbol down inside a narrower container — a phone held in portrait,
 * most obviously. That is lossless: `QRCodeSVG` emits a
 * `viewBox="0 0 modules modules"`, so the rendered edge is independent of the module
 * grid and CSS width wins over the SVG's own width attribute. Scaling a canvas
 * would have meant resampling, which is the reason the components render SVG.
 */
export const QR_SIZE_PX = 384

/**
 * Quiet zone, in modules. The QR specification requires 4, and the library
 * defaults to 0: without it a scanner cannot find the symbol's edges against a
 * busy card or slide.
 */
export const QR_MARGIN_MODULES = 4

/**
 * Error correction level. `M` recovers ~15% of a damaged or partly obscured
 * symbol — the realistic failure mode is glare and heads in the way, not a
 * pristine scan — and costs only a slightly denser grid at these URL lengths.
 */
export const QR_ERROR_CORRECTION = 'M'
