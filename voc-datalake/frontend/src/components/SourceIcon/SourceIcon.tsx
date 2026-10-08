/**
 * @fileoverview A feedback source rendered as its lucide icon (see sourceIcons.ts).
 *
 * @module components/SourceIcon
 */
import type { LucideIcon } from 'lucide-react'
import { sourceIcon } from './sourceIcons'

interface GlyphProps {
  readonly size: number
  readonly className?: string
}

/** Renders an icon handed in as a prop: a component never looked up during render. */
export function IconGlyph({ icon: Icon, size, className }: GlyphProps & { readonly icon: LucideIcon }) {
  return <Icon size={size} className={className} aria-hidden="true" />
}

/** A decorative source icon; the source name is always shown as text beside it. */
export function SourceIcon({ platform, channel, size = 16, className }: Partial<GlyphProps> & {
  readonly platform: string
  readonly channel?: string
}) {
  return <IconGlyph icon={sourceIcon(platform, channel)} size={size} className={className} />
}
