/**
 * @fileoverview A page's title block: the `h1` and its one-line subtitle.
 * @module components/PageTitle/PageTitle
 */

export function PageTitle({ title, subtitle }: Readonly<{ title: string; subtitle: string }>) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-text-strong">{title}</h1>
      {/* max-w-prose: a full-width subtitle ran to ~165 characters a line at 1440px (D-READ). */}
      <p className="text-sm text-muted mt-1 max-w-prose">{subtitle}</p>
    </div>
  )
}
