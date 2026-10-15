/**
 * @fileoverview Barrel for the QR dialog. Exports `FormQrCode` only.
 *
 * `FormQrButton` is deliberately NOT re-exported here, and its two consumers
 * import it deeply as `components/FormQrCode/FormQrButton`. Adding
 * `export { default as FormQrButton } from './FormQrButton'` is a build failure,
 * not a style preference: `react-refresh/only-export-components` cannot see
 * through a re-export to tell that the binding is a component, so a second export
 * in this file warns —
 *
 *   1:10  warning  Fast refresh only works when a file only exports components.
 *         Use a new file to share constants or functions between components
 *
 * — and `npm run lint` runs `eslint . --max-warnings 0`, which turns that warning
 * into a non-zero exit. `allowConstantExport` does not help; it exempts constants,
 * not re-exports. One export is the most this file can carry.
 *
 * @module components/FormQrCode
 */
export { default } from './FormQrCode'
