/**
 * @fileoverview Shows a presigned S3 image under the app's CSP.
 *
 * The site's Content-Security-Policy allows images only from `'self'` and `data:`
 * (lib/stacks/core-cdn.ts), so an `<img>` pointing at a presigned S3 URL (the
 * company logo, a reference's logo preview) is blocked. Rather than widening
 * `img-src`, the image is fetched — `connect-src` allows `*.amazonaws.com` and the
 * raw bucket's CORS allows GET from the site — and handed to `<img>` as a `data:`
 * URL. Only raster types are accepted (png, jpeg, webp, gif), at most 5 MB; any other
 * answer, or a failed fetch, yields `undefined` so the caller shows its fallback.
 *
 * @module hooks/useInlineImage
 */
import { useQuery } from '@tanstack/react-query'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const RASTER_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Bytes per `String.fromCharCode` call: a 5 MB spread would overflow the call stack. */
const CHUNK = 0x8000

/**
 * `bytes` as a `data:<type>;base64,` URL. Built from the raw bytes, not a Blob + FileReader: the
 * Blob a fetch answer yields is not always the Blob class FileReader accepts (Node 22's undici
 * under jsdom refused it in CI), and the bytes are all a data: URL needs.
 */
function toDataUrl(bytes: Uint8Array, type: string): string {
  const chunks = Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, index) =>
    String.fromCharCode(...bytes.subarray(index * CHUNK, (index + 1) * CHUNK)))
  return `data:${type};base64,${btoa(chunks.join(''))}`
}

/** The image at `url` as a `data:` URL (a same-origin path as is), or null when it is not a raster image the page may show. */
export async function fetchInlineImage(url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) return url
  // A same-origin path is already allowed by img-src 'self' (the dev mock serves one).
  if (url.startsWith('/') && !url.startsWith('//')) return url
  if (!url.startsWith('https://')) return null
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) return null
  const type = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!RASTER_TYPES.has(type)) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  return toDataUrl(bytes, type)
}

/**
 * `url` as something an `<img src>` may load under the CSP; `undefined` while loading, when
 * there is no url, or when it cannot be shown. A presigned URL changes on every read, so the
 * cache key drops its query string (the signature) to avoid refetching the same object.
 */
export function useInlineImage(url: string | undefined): string | undefined {
  const key = url?.split('?')[0]
  const { data } = useQuery({
    queryKey: ['inline-image', key],
    queryFn: () => (url ? fetchInlineImage(url) : Promise.resolve(null)),
    enabled: Boolean(url),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
  return data ?? undefined
}
