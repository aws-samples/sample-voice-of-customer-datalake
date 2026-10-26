/**
 * @fileoverview Semantic tones of the Kiro design system.
 *
 * Variant props that pick a colour take a Tone — never a hue name like
 * 'blue' or 'green' — so a component's meaning survives a theme change.
 * See docs/kiro-design-system.md § Colour → Semantic tones.
 *
 * `aim` (AI / generated) is a design-system tone too, but no variant prop takes it:
 * the few places that show it use its classes directly (`badge-aim`, `text-aim`).
 * Add it here when a variant prop first needs it.
 *
 * @module theme/tones
 */

export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'muted'
