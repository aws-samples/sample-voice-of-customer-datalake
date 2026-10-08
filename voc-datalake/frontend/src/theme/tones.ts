/**
 * @fileoverview Semantic tones of the Kiro design system.
 *
 * Variant props that pick a colour take a Tone — never a hue name like
 * 'blue' or 'green' — so a component's meaning survives a theme change.
 * See docs/kiro-design-system.md § Colour → Semantic tones.
 *
 * @module theme/tones
 */

export type Tone = 'accent' | 'aim' | 'ok' | 'warn' | 'danger' | 'info' | 'muted'
