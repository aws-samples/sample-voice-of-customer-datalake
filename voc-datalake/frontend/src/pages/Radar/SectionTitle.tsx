/**
 * @fileoverview The heading every Radar card opens with: an accent icon and the title.
 * @module pages/Radar/SectionTitle
 */
import type { LucideIcon } from 'lucide-react'

export default function SectionTitle({ id, icon: Icon, children }: Readonly<{ id: string; icon: LucideIcon; children: string }>) {
  return (
    <h2 id={id} className="text-lg font-semibold tracking-tight text-text-strong flex items-center gap-2 mb-3">
      <Icon size={16} className="text-accent" aria-hidden="true" />{children}
    </h2>
  )
}
