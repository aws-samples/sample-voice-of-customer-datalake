/**
 * @fileoverview The root `<svg>` every non-Kiro theme mark shares: decorative
 * (`aria-hidden`, not focusable, no title; the text beside a mark names the
 * product), tagged `data-mark="<theme id>"`, sized by the caller's className.
 * @module components/ThemeMark/MarkSvg
 */
import type { ReactNode } from 'react'
import type { ColorThemeId } from '../../theme/themeCatalog'

export interface MarkProps {
  className?: string
}

/** The static mark's props: it may sit on a filled surface (the accent launcher). */
export interface StaticMarkProps extends MarkProps {
  /** A brand-coloured mark (Quick) draws in `currentColor` instead, keeping its contrast on the fill. */
  onFill?: boolean
}

export default function MarkSvg({ theme, viewBox, className, children }: Readonly<{
  theme: ColorThemeId
  viewBox: string
  className?: string
  children: ReactNode
}>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      fill="none"
      className={className}
      aria-hidden
      focusable={false}
      data-mark={theme}
    >
      {children}
    </svg>
  )
}
