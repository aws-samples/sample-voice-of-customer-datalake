/**
 * @fileoverview Why a board write failed. The API answers `{success: false, error: <English sentence>}`
 * (shared/api.py), so a refusal it has a translated sentence for (403 / 404 / 409, WRITE_ERRORS) is
 * shown translated; any other status shows the server's own reason (a 400 names the field), else
 * the generic sentence.
 */
import { useTranslation } from 'react-i18next'
import { writeErrorText } from './writeErrorText'

export default function WriteError({ error }: Readonly<{ error: unknown }>) {
  const { t } = useTranslation('featureRequests')
  if (error === null || error === undefined) return null
  return <p role="alert" className="text-[12px] text-danger break-words">{writeErrorText(error, t)}</p>
}
