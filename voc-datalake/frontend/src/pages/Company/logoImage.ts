/**
 * @fileoverview The company logo, made small before it is uploaded.
 *
 * A logo never needs more than {@link LOGO_MAX_EDGE_PX} on its longest side: the app shows it at 64 px and a
 * prototype at 24-80 px. A larger file is shrunk here instead of refused, with the same decode and re-encode
 * ladder product-doc images use (`pages/ProjectDetail/resizeImage.ts`), so the API stores a small logo and the
 * prototype build can inline it (`lambda/shared/company_logo.py` leaves out a logo over 1 MB).
 *
 * The ladder keeps transparency on every rung: PNG first, then WebP (lossy, with alpha). Never JPEG, whose
 * missing alpha channel would put a white box behind a transparent logo. An SVG is drawn to a PNG first
 * (`utils/svgToPng`) and that PNG goes through the same policy.
 *
 * @module pages/Company/logoImage
 */
import { prepareImage } from '../ProjectDetail/resizeImage'
import type { ImagePolicy } from '../ProjectDetail/resizeImage'
import { isSvgFile, svgToPng } from '../../utils/svgToPng'

/** The longest side of an uploaded logo, in px (the size `svgToPng` draws an SVG at). */
export const LOGO_MAX_EDGE_PX = 1024
/** The byte target: the most a prototype inlines (`MAX_INLINE_LOGO_BYTES`, lambda/shared/company_logo.py). */
export const LOGO_MAX_BYTES = 1_000_000

export const LOGO_IMAGE_POLICY: ImagePolicy = {
  maxBytes: LOGO_MAX_BYTES,
  maxEdge: LOGO_MAX_EDGE_PX,
  ladder: [
    { type: 'image/png', maxEdge: LOGO_MAX_EDGE_PX },
    { type: 'image/webp', quality: 0.92, maxEdge: LOGO_MAX_EDGE_PX },
    { type: 'image/webp', quality: 0.8, maxEdge: LOGO_MAX_EDGE_PX },
    { type: 'image/webp', quality: 0.8, maxEdge: 768 },
    { type: 'image/webp', quality: 0.7, maxEdge: 512 },
  ],
}

/** The file to upload for `file`: an SVG drawn to PNG, then a file over 1 MB shrunk (one within it is kept as-is). */
export async function uploadableLogo(file: File): Promise<File> {
  const raster = isSvgFile(file) ? await svgToPng(file) : file
  // Within the byte target the logo is used as it is whatever its pixel size: no decode, no re-encode loss.
  if (raster.size <= LOGO_MAX_BYTES) return raster
  const prepared = await prepareImage(raster, LOGO_IMAGE_POLICY)
  if (prepared.blob === raster) return raster
  return new File([prepared.blob], prepared.filename, { type: prepared.contentType })
}
