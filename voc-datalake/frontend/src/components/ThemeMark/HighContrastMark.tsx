/**
 * @fileoverview The High Contrast mark: the contrast symbol, a circle with a
 * heavy 3-unit `currentColor` outline and its right half filled. No thin
 * details, so it reads at any size.
 * @module components/ThemeMark/HighContrastMark
 */
import MarkSvg from './MarkSvg'
import type { MarkProps } from './MarkSvg'

export default function HighContrastMark({ className }: Readonly<MarkProps>) {
  return (
    <MarkSvg theme="highcontrast" viewBox="0 0 24 24" className={className}>
      <circle cx={12} cy={12} r={9} stroke="currentColor" strokeWidth={3} />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
    </MarkSvg>
  )
}
