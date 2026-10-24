/**
 * Persona avatar references → one valid signed CloudFront URL.
 *
 * Used by the assistant's consult_personas tool (via `assistant/tools/deps.ts`)
 * so persona cards carry avatar URLs the SPA can load.
 */
import { signCloudFrontUrl } from '../lib/cloudfront-signing.js';

// Stryker disable next-line StringLiteral: any fallback that is not an absolute URL fails URL.parse exactly as '' does
const AVATARS_CDN_URL = process.env.AVATARS_CDN_URL ?? '';
const AVATAR_KEY_PREFIX = 'avatars/';

/** Convert an S3 URI (s3://bucket/avatars/{persona}/{digest}.<ext>, or legacy avatars/file.<ext>) to a CloudFront CDN URL. */
function stripTrailingSlashes(value: string): string {
  // Recursive instead of a trailing-slash regex: sonarjs flags /\/+$/ as
  // backtracking-prone, and the input is a short constant env URL.
  return value.endsWith('/') ? stripTrailingSlashes(value.slice(0, -1)) : value;
}

function trustedAvatarCdnUrl(url: string): URL | undefined {
  const configured = URL.parse(stripTrailingSlashes(AVATARS_CDN_URL));
  const candidate = URL.parse(url);
  if (!configured || !candidate) return undefined;
  const pathPrefix = `${stripTrailingSlashes(configured.pathname)}/`;
  return candidate.origin === configured.origin && candidate.pathname.startsWith(pathPrefix)
    ? candidate
    : undefined;
}

/**
 * The CDN path of an `s3://bucket/...` avatar reference. The `/avatars/*` behavior
 * maps 1:1 to the `avatars/` key prefix, so it is the key below that prefix:
 * `{persona_id}/{digest}.jpeg` for a current image (a new key per regeneration),
 * `{persona_id}.jpeg` for a legacy flat one. Anything else keeps its last segment.
 */
function avatarCdnPath(s3Uri: string): string | undefined {
  const key = s3Uri.slice('s3://'.length).split('/').slice(1).join('/');
  return key.startsWith(AVATAR_KEY_PREFIX) ? key.slice(AVATAR_KEY_PREFIX.length) : s3Uri.split('/').at(-1);
}

const CLOUDFRONT_AUTH_PARAMS = ['Expires', 'Signature', 'Key-Pair-Id'];

function hasCurrentCloudFrontSignature(url: URL): boolean {
  if (CLOUDFRONT_AUTH_PARAMS.some(
    (name) => url.searchParams.getAll(name).length !== 1,
  )) return false;
  // Exactly one of each is present here, so `get` cannot be null.
  const expires = Number.parseInt(String(url.searchParams.get('Expires')), 10);
  return Number.isSafeInteger(expires)
    && expires > Math.floor(Date.now() / 1000)
    && Boolean(url.searchParams.get('Signature'))
    && Boolean(url.searchParams.get('Key-Pair-Id'));
}

function withoutCloudFrontAuth(url: URL): string {
  const unsigned = new URL(url);
  for (const name of CLOUDFRONT_AUTH_PARAMS) unsigned.searchParams.delete(name);
  return unsigned.toString();
}

/**
 * Turn an avatar reference into one valid signed CloudFront URL.
 *
 * The canonical Projects API already signs stored S3 avatar references. Keep a
 * current, complete signature unchanged; signing it again would duplicate the
 * reserved auth parameters and invalidate the resource. Legacy unsigned,
 * partial, or expired CDN URLs are stripped of stale auth before re-signing.
 */
export async function resolveAvatarUrl(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  if (!url.startsWith('s3://')) {
    const trustedUrl = trustedAvatarCdnUrl(url);
    if (!trustedUrl) return undefined;
    if (hasCurrentCloudFrontSignature(trustedUrl)) return trustedUrl.toString();
    return signCloudFrontUrl(withoutCloudFrontAuth(trustedUrl));
  }
  const path = avatarCdnPath(url);
  if (!path) return undefined;
  const trustedUrl = trustedAvatarCdnUrl(
    `${stripTrailingSlashes(AVATARS_CDN_URL)}/${path}`,
  );
  return trustedUrl ? signCloudFrontUrl(trustedUrl.toString()) : undefined;
}
