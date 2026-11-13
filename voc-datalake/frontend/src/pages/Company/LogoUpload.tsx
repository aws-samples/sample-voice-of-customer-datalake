/**
 * @fileoverview Company → Design system → the company logo and its upload.
 *
 * PNG, JPEG and WebP within 1024 px and 1 MB go to the presigned PUT as they are; a larger one is
 * made smaller first (`./logoImage`), never refused for its size (up to {@link LOGO_MAX_INPUT_BYTES}).
 * An SVG is converted to PNG in the browser first (`utils/svgToPng`) and only the PNG is uploaded:
 * the logo route refuses SVG because an SVG can carry script, and the SVG bytes never leave the browser.
 *
 * @module pages/Company/LogoUpload
 */
import { useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Image, Loader2, Upload } from 'lucide-react'
import type { TFunction } from 'i18next'
import { designSystemApi, designSystemKey, putToPresigned, UPLOAD_LIMITS, uploadRejection } from '../../api/designSystemApi'
import type { DraftLogo } from '../../api/designSystemApi'
import { isSvgConversionError, isSvgFile } from '../../utils/svgToPng'
import type { SvgConversionReason } from '../../utils/svgToPng'
import { useInlineImage } from '../../hooks/useInlineImage'
import { isImagePrepError } from '../ProjectDetail/resizeImage'
import { uploadableLogo } from './logoImage'
import { GroupLabel } from './ContextParts'
import { useUploadError } from './useUploadError'

/** The picker also offers SVG (by type and by extension: some systems report no type for .svg). */
const LOGO_ACCEPT = [...UPLOAD_LIMITS.logo.types, 'image/svg+xml', '.svg'].join(',')

/** What the admin reads when an SVG could not become a PNG (literal keys, so the i18n audit sees them). */
function svgErrorMessage(reason: SvgConversionReason, name: string, t: TFunction<'settings'>): string {
  switch (reason) {
    case 'too_large': return t('designSystem.svg.tooLarge', { name })
    case 'unreadable': return t('designSystem.svg.unreadable', { name })
    case 'timeout': return t('designSystem.svg.timeout', { name })
    case 'not_converted': return t('designSystem.svg.notConverted')
    case 'result_too_large': return t('designSystem.svg.resultTooLarge')
  }
}

/** The largest raster file the browser shrinks: anything bigger is refused before it is decoded. */
const LOGO_MAX_INPUT_BYTES = 25 * 1024 * 1024

/** What the admin reads when an upload failed (literal keys, so the i18n audit sees them). */
function uploadErrorMessage(failure: unknown, name: string, t: TFunction<'settings'>): string {
  if (isSvgConversionError(failure)) return svgErrorMessage(failure.reason, name, t)
  if (isImagePrepError(failure)) {
    return failure.failure === 'too-large' ? t('designSystem.logoNotShrunk', { name }) : t('designSystem.logoUnreadable', { name })
  }
  return t('designSystem.uploadFailed')
}

export function LogoUpload({ logoUrl, draftLogo, canEdit }: Readonly<{
  logoUrl: string | undefined
  /** A reference's logo in the unsaved draft: shown instead of the saved one until Save or Discard. */
  draftLogo?: DraftLogo | null
  canEdit: boolean
}>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const [error, setError] = useState<string | null>(null)
  const rejectionFor = useUploadError()
  // Presigned S3 URL → data: URL (the CSP allows only 'self' and data: images).
  const logoSrc = useInlineImage(draftLogo?.url ?? logoUrl)
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const logo = await uploadableLogo(file)
      const target = await designSystemApi.createLogoUpload(logo.type, logo.size)
      if (!target) throw new Error('no upload target')
      await putToPresigned(target, logo)
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: designSystemKey() }),
    onError: (failure, file) => setError(uploadErrorMessage(failure, file.name, t)),
  })
  const onFile = (file: File | undefined) => {
    if (!file) return
    setError(null)
    // An SVG is checked by the converter (its own size cap, then the PNG's). A raster file is checked for its
    // TYPE only: a large one is made smaller before the upload (the result is far under the route's cap).
    if (!isSvgFile(file)) {
      if (uploadRejection('logo', file) === 'type') {
        setError(rejectionFor('logo', file))
        return
      }
      if (file.size > LOGO_MAX_INPUT_BYTES) {
        setError(t('designSystem.uploadTooLarge', { name: file.name, mb: LOGO_MAX_INPUT_BYTES / 1024 / 1024 }))
        return
      }
    }
    upload.mutate(file)
  }

  return (
    <div>
      <GroupLabel>{t('designSystem.logo')}</GroupLabel>
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded-lg border border-border bg-bg-accent flex items-center justify-center overflow-hidden">
          {logoSrc ? <img src={logoSrc} alt={t('designSystem.logoAlt')} className="max-w-full max-h-full object-contain" /> : <Image size={20} className="text-muted" />}
        </div>
        {canEdit ? (
          <>
            {/* tabIndex -1: the button below is the control; the hidden input was a second, invisible Tab stop. */}
            <input ref={inputRef} type="file" tabIndex={-1} accept={LOGO_ACCEPT} className="sr-only" aria-label={t('designSystem.uploadLogo')} aria-describedby={hintId} onChange={(e) => onFile(e.target.files?.[0])} />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.isPending} aria-describedby={hintId} className="btn btn-secondary btn-sm flex items-center gap-1.5">
              {upload.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {t('designSystem.uploadLogo')}
            </button>
          </>
        ) : null}
      </div>
      {canEdit ? <p id={hintId} className="text-xs text-muted mt-1">{t('designSystem.logoHint')}</p> : null}
      {draftLogo ? <p className="text-xs text-muted mt-1">{t('designSystem.logoInDraft')}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger mt-1">{error}</p> : null}
    </div>
  )
}
