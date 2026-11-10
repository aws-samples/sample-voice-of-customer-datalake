/**
 * PersonaSection - Wrapper for persona detail sections.
 *
 * A neutral card by default: the icon and the title say which section this is
 * (labels vs status, rule 15). `color` is for a STATE only — see `sectionClasses`.
 */
import clsx from 'clsx'
import { sectionClasses } from './types'
import type { PersonaSectionProps } from './types'

export default function PersonaSection({
  title, icon: Icon, color, children,
}: Readonly<PersonaSectionProps>) {
  const colorClasses = sectionClasses(color)

  return (
    <div className={clsx('rounded-lg border p-4', colorClasses.border)}>
      <h3 className={clsx('font-medium mb-3 flex items-center gap-2', colorClasses.title)}>
        {/* 16px muted lucide glyph (design-system "Icons" sizes); the tone stays on the title text. */}
        <Icon size={16} className="text-muted shrink-0" aria-hidden="true" data-testid="persona-section-icon" />
        {title}
      </h3>
      {children}
    </div>
  )
}
