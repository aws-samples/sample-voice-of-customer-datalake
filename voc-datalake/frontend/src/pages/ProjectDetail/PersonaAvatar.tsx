/**
 * PersonaAvatar - Shows AI-generated image or fallback gradient avatar
 */
import clsx from 'clsx'
import { useState } from 'react'
import { SIZE_CLASSES } from './types'
import type { PersonaAvatarProps } from './types'

// Fallback gradient avatar component - defined outside to avoid recreation during render
function FallbackAvatar({
  name, sizeClass,
}: Readonly<{
  name: string;
  sizeClass: string
}>) {
  return (
    <div className={clsx(sizeClass, 'bg-accent rounded-full flex items-center justify-center text-accent-fg font-bold flex-shrink-0')}>
      {name.charAt(0)}
    </div>
  )
}

export default function PersonaAvatar({
  persona, size = 'md',
}: Readonly<PersonaAvatarProps>) {
  // The URL that failed, not a flag: a regenerated avatar is a NEW URL, which
  // must get its own chance to load instead of inheriting the old failure.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  const sizeClass = SIZE_CLASSES[size]
  const avatarUrl = persona.avatar_url

  if (avatarUrl != null && avatarUrl !== '' && avatarUrl !== failedUrl) {
    return (
      <div className="relative flex-shrink-0">
        <img
          src={avatarUrl}
          alt={persona.name}
          className={clsx(sizeClass, 'rounded-full object-cover border-2 border-accent/30 flex-shrink-0')}
          onError={() => setFailedUrl(avatarUrl)}
        />
      </div>
    )
  }

  return <FallbackAvatar name={persona.name} sizeClass={sizeClass} />
}
