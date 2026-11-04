/**
 * @fileoverview The Nord mark: a crisp six-armed snowflake in `currentColor`.
 * One arm (a spoke with a chevron two thirds out) drawn six times, 60° apart,
 * on a 24-unit grid with a 2-unit round stroke so it still reads at 20 px.
 * @module components/ThemeMark/NordMark
 */
import MarkSvg from './MarkSvg'
import type { MarkProps } from './MarkSvg'

/** The arm pointing up from the centre (12, 12): the spoke, then its chevron. */
const ARM = 'M12 12V2.5M8.8 4.6 12 7.8l3.2-3.2'
const ANGLES = [0, 60, 120, 180, 240, 300] as const

export default function NordMark({ className }: Readonly<MarkProps>) {
  return (
    <MarkSvg theme="nord" viewBox="0 0 24 24" className={className}>
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {ANGLES.map((angle) => (
          <path key={angle} d={ARM} transform={angle === 0 ? undefined : `rotate(${angle} 12 12)`} />
        ))}
      </g>
    </MarkSvg>
  )
}
