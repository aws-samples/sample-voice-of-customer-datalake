/**
 * @fileoverview The message for a file the design-system uploads refuse (type or size).
 *
 * @module pages/Company/useUploadError
 */
import { useTranslation } from 'react-i18next'
import { UPLOAD_LIMITS, uploadRejection } from '../../api/designSystemApi'
import type { UploadTarget } from '../../api/designSystemApi'

/** Translates a rejected file into the message the user sees (null when it is accepted). */
export function useUploadError() {
  const { t } = useTranslation('settings')
  return (target: UploadTarget, file: File): string | null => {
    const rejection = uploadRejection(target, file)
    if (rejection === 'type') return t('designSystem.uploadBadType', { name: file.name })
    if (rejection === 'size') return t('designSystem.uploadTooLarge', { name: file.name, mb: UPLOAD_LIMITS[target].maxBytes / 1024 / 1024 })
    return null
  }
}
