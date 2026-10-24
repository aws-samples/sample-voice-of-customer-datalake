/**
 * Cursor pages for the dev mock's `/feedback/urgent` and `/feedback/search`,
 * in the real routes' wire shape (`lambda/shared/feedback_cursor.py`):
 * `{count, total, has_more, next_token, items}`. `total` is published on the
 * first page only (the urgent route answers `null` on later pages), and
 * `next_token` is opaque base64url (here: the offset), refused with a 400 when
 * it is not one this mock issued.
 */

const MAX_OFFSET = 5000;

/** The page size the routes clamp to (1-100). */
function pageLimitOf(searchParams, fallback) {
  const raw = Number(searchParams?.get('limit'));
  return Math.min(Math.max(Number.isInteger(raw) && raw > 0 ? raw : fallback, 1), 100);
}

function decodeOffset(token) {
  if (!token) return { offset: 0 };
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (Number.isInteger(value?.o) && value.o >= 0 && value.o <= MAX_OFFSET) return { offset: value.o };
  } catch {
    // Falls through to the refusal below.
  }
  return { error: 'next_token is not valid' };
}

const encodeOffset = (offset) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

/**
 * One page of `matches` for the request's `limit` / `next_token`, or `{error}`.
 * `totalOnLaterPages` mirrors search (always a total) vs urgent (first page only).
 */
export function cursorPage(matches, searchParams, { fallbackLimit, totalOnLaterPages }) {
  const token = searchParams?.get('next_token') || '';
  const { offset, error } = decodeOffset(token);
  if (error) return { error };
  const items = matches.slice(offset, offset + pageLimitOf(searchParams, fallbackLimit));
  const next = offset + items.length;
  const hasMore = items.length > 0 && next < matches.length;
  return {
    count: items.length,
    total: token && !totalOnLaterPages ? null : matches.length,
    has_more: hasMore,
    next_token: hasMore ? encodeOffset(next) : null,
    items,
  };
}
