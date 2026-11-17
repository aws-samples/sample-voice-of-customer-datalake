/**
 * @fileoverview A node's glyph by name (nodeGlyphs.ts `GLYPHS`): decorative, the words beside it name the step.
 *
 * @module components/WorkflowEditor/nodes/GlyphIcon
 */
import { Bot } from 'lucide-react'
import { GLYPHS } from './nodeGlyphs'

export function GlyphIcon({ name, size, className }: Readonly<{ name: string; size: number; className?: string }>) {
  const Icon = GLYPHS[name] ?? Bot
  return <Icon size={size} className={className} aria-hidden="true" />
}
