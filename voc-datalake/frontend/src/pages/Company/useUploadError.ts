/**
 * @fileoverview The message for a file the design-system uploads refuse (type or size).
 *
 * @module pages/Company/useUploadError
 */
import { useTranslation } from 'react-i18next'
import { UPLOAD_LIMITS, uploadRejection } from '../../api/designSystemApi'
import type { UploadTarget } from '../../api/designSystemApi'

const MIB = 1024 * 1024

/** A cap in MB as people read it: 5 MiB → 5, the decimal 1,000,000-byte logo cap → 1 (never 0.95367431640625). */
export function megabytes(bytes: number): number {
  return bytes % MIB === 0 ? bytes / MIB : Math.round(bytes / 100_000) / 10
}

/** Translates a rejected file into the message the user sees (null when it is accepted). */
export function useUploadError() {
  const { t } = useTranslation('settings')
  return (target: UploadTarget, file: File): string | null => {
    const rejection = uploadRejection(target, file)
    if (rejection === 'type') return t('designSystem.uploadBadType', { name: file.name })
    if (rejection === 'size') return t('designSystem.uploadTooLarge', { name: file.name, mb: megabytes(UPLOAD_LIMITS[target].maxBytes) })
    return null
  }
}
