/**
 * @fileoverview The Dracula mark: a bat in flight, one filled `currentColor`
 * silhouette on a 24-unit grid. Pointed ears, wings spread to the edges with
 * two scallops each on the trailing edge, the body tapering to a point.
 * @module components/ThemeMark/DraculaMark
 */
import MarkSvg from './MarkSvg'
import type { MarkProps } from './MarkSvg'

const BAT = [
  'M12 6.6 13.4 3.8 14.2 7.2',
  'C16.4 5.6 19.6 5 23 6.6',
  'C21.4 8.4 20.8 11 21.2 14.4',
  'C19.8 12.8 17.8 12.8 16.8 14.6',
  'C15.6 13.6 14.2 14.4 13.8 16.4',
  'L12 20.2 10.2 16.4',
  'C9.8 14.4 8.4 13.6 7.2 14.6',
  'C6.2 12.8 4.2 12.8 2.8 14.4',
  'C3.2 11 2.6 8.4 1 6.6',
  'C4.4 5 7.6 5.6 9.8 7.2',
  'L10.6 3.8Z',
].join('')

export default function DraculaMark({ className }: Readonly<MarkProps>) {
  return (
    <MarkSvg theme="dracula" viewBox="0 0 24 24" className={className}>
      <path d={BAT} fill="currentColor" stroke="currentColor" strokeWidth={0.6} strokeLinejoin="round" />
    </MarkSvg>
  )
}
