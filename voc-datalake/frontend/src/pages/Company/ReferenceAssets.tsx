/**
 * @fileoverview The local copies a reference keeps beside its logo preview (5.48): the site's icons and the
 * sanitised SVG of a rendered logo.
 *
 * Every image is the server's own copy (a signed S3 URL), read through `useInlineImage` like the logo preview,
 * so the remote original is never loaded. An SVG is never put into the page: it is offered only as a download
 * link, and S3 answers it with `Content-Disposition: attachment`.
 *
 * @module pages/Company/ReferenceAssets
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Image } from 'lucide-react'
import type { DesignIcon } from '../../api/designSystemApi'
import { useInlineImage } from '../../hooks/useInlineImage'

/** "Download SVG" for a sanitised SVG copy; nothing without one. */
export function SvgDownloadLink({ url }: Readonly<{ url: string | undefined }>) {
  const { t } = useTranslation('settings')
  if (!url) return null
  return (
    <a href={url} download="logo.svg" rel="noreferrer noopener" referrerPolicy="no-referrer"
      className="link inline-flex items-center gap-1 text-xs">
      <Download size={12} aria-hidden="true" /> {t('designSystem.preview.downloadSvg')}
    </a>
  )
}

/** The two thumbnail sizes: an icon in the strip, the logo candidate beside the preview. */
const THUMBNAIL = {
  icon: { box: 'w-8 h-8 rounded-sm', glyph: 14 },
  logo: { box: 'w-14 h-14 rounded-md flex-shrink-0', glyph: 18 },
} as const

/**
 * A stored copy (a presigned S3 URL) read through `useInlineImage`, so the app's CSP `img-src 'self' data:`
 * allows it; without a URL, or when it fails to load, a neutral glyph. The remote original is never loaded.
 */
export function StoredImageThumbnail({ url, alt, title, size, as: Box = 'div' }: Readonly<{
  url: string | undefined; alt: string; title?: string; size: keyof typeof THUMBNAIL; as?: 'div' | 'li'
}>) {
  const [failed, setFailed] = useState(false)
  const inline = useInlineImage(url)
  const src = failed ? undefined : inline
  const { box, glyph } = THUMBNAIL[size]
  return (
    <Box className={`${box} border border-border bg-bg-elevated flex items-center justify-center overflow-hidden`} title={title}>
      {src === undefined ? (
        <Image size={glyph} className="text-muted" role="img" aria-label={alt} />
      ) : (
        <img src={src} alt={alt} referrerPolicy="no-referrer" className="max-w-full max-h-full object-contain"
          onError={() => setFailed(true)} />
      )}
    </Box>
  )
}

/** The reference's copied icons, in the order the page names them; nothing when there are none. */
export function IconStrip({ icons }: Readonly<{ icons: readonly DesignIcon[] }>) {
  const { t } = useTranslation('settings')
  if (icons.length === 0) return null
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label={t('designSystem.preview.icons')} data-testid="reference-icons">
      {icons.map((icon) => (
        <StoredImageThumbnail key={icon.url.split('?')[0]} as="li" size="icon" url={icon.url}
          alt={t('designSystem.preview.iconAlt')} title={icon.sizes} />
      ))}
    </ul>
  )
}
