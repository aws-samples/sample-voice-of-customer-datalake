/**
 * @fileoverview The brand mark of the active colour theme (themeCatalog.ts), in
 * three poses: {@link ThemeMark} (the static mark: menu, sign-in, the assistant's
 * bubble and header), {@link ThemeMarkIdle} (the assistant's empty state) and
 * {@link ThemeMarkThinking} (its busy indicator). Each follows the theme live
 * through `useActiveColorTheme()`.
 *
 * Kiro keeps its ghost (KiroGhost, GhostPoses). Nord: a snowflake; Dracula: a bat;
 * High Contrast: the contrast circle — all `currentColor`, so the caller's text
 * class colours them. Quick: its four-point spark in the brand gradient (in
 * `currentColor` with `onFill`, on the accent launcher). Every mark is decorative
 * (`aria-hidden`); the text beside it names things. The thinking pose floats
 * (`animate-float`), or for Quick spins the spark; both stop under
 * `prefers-reduced-motion`.
 *
 * @module components/ThemeMark
 */
import clsx from 'clsx'
import KiroGhost from '../KiroGhost/KiroGhost'
import { GhostIdle, GhostThinking } from '../KiroGhost/GhostPoses'
import { useActiveColorTheme } from '../../theme/useActiveColorTheme'
import NordMark from './NordMark'
import DraculaMark from './DraculaMark'
import HighContrastMark from './HighContrastMark'
import QuickMark, { QuickMarkThinking } from './QuickMark'
import type { ColorThemeId } from '../../theme/themeCatalog'
import type { ComponentType } from 'react'
import type { MarkProps } from './MarkSvg'

/** The static mark of every theme but Kiro (whose idle and thinking poses differ from its mark). */
const STATIC_MARKS: Record<Exclude<ColorThemeId, 'kiro'>, ComponentType<MarkProps>> = {
  nord: NordMark,
  dracula: DraculaMark,
  highcontrast: HighContrastMark,
  quick: QuickMark,
}

const FLOAT = 'animate-float motion-reduce:animate-none'

export default function ThemeMark({ className, onFill }: Readonly<MarkProps>) {
  const theme = useActiveColorTheme()
  if (theme === 'kiro') return <KiroGhost className={className} />
  const Mark = STATIC_MARKS[theme]
  return <Mark className={className} onFill={onFill} />
}

/** At rest, greeting an empty conversation. */
export function ThemeMarkIdle({ className }: Readonly<MarkProps>) {
  const theme = useActiveColorTheme()
  if (theme === 'kiro') return <GhostIdle className={className} />
  const Mark = STATIC_MARKS[theme]
  return <Mark className={className} />
}

/** While the assistant works: the mark floats (Quick: its spark spins). */
export function ThemeMarkThinking({ className }: Readonly<MarkProps>) {
  const theme = useActiveColorTheme()
  if (theme === 'kiro') return <GhostThinking className={className} />
  if (theme === 'quick') return <QuickMarkThinking className={className} />
  const Mark = STATIC_MARKS[theme]
  return <Mark className={clsx(FLOAT, className)} />
}
