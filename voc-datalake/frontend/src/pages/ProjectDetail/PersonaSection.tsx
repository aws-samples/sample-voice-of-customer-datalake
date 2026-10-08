/**
 * PersonaSection - Wrapper for persona detail sections with colored styling
 */
import clsx from 'clsx'
import { SECTION_COLOR_CLASSES } from './types'
import type { PersonaSectionProps } from './types'

export default function PersonaSection({
  title, icon: Icon, color, children,
}: Readonly<PersonaSectionProps>) {
  const colorClasses = SECTION_COLOR_CLASSES[color]

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
