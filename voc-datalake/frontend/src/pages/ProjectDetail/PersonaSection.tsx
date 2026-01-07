/**
 * PersonaSection - Wrapper for persona detail sections with colored styling
 */
import clsx from 'clsx'
import type { PersonaSectionProps } from './types'
import { SECTION_COLOR_CLASSES } from './types'

export default function PersonaSection({ title, icon, color, children }: Readonly<PersonaSectionProps>) {
  const colorClasses = SECTION_COLOR_CLASSES[color]
  
  return (
    <div className={clsx('rounded-lg border p-4', colorClasses.border)}>
      <h4 className={clsx('font-medium mb-3 flex items-center gap-2', colorClasses.title)}>
        <span>{icon}</span> {title}
      </h4>
      {children}
    </div>
  )
}
