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
    <div className={clsx(sizeClass, 'bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0')}>
      {name.charAt(0)}
    </div>
  )
}

export default function PersonaAvatar({
  persona, size = 'md',
}: Readonly<PersonaAvatarProps>) {
  const [imageError, setImageError] = useState(false)

  const sizeClass = SIZE_CLASSES[size]
  const avatarUrl = persona.avatar_url

  if (avatarUrl != null && avatarUrl !== '' && !imageError) {
    return (
      <div className="relative flex-shrink-0">
        <img
          src={avatarUrl}
          alt={persona.name}
          className={clsx(sizeClass, 'rounded-full object-cover border-2 border-purple-200 flex-shrink-0')}
          onError={() => setImageError(true)}
        />
      </div>
    )
  }

  return <FallbackAvatar name={persona.name} sizeClass={sizeClass} />
}
