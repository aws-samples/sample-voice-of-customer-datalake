/**
 * What the model reads from the Radar API (`get_radar`): the answer a person
 * gets is built from these, so the shaping decides what they see.
 *
 * - **Releases cite ready-made links.** A release's `urls[]` / `titles[]`
 *   become `links`: markdown links with a short title ("Coding sessions ·
 *   Jun 11"), https only (an `http` link is upgraded — browsers' HTTPS-first
 *   default), one per page across the whole list (scheme, `www.` and a trailing
 *   slash do not make two pages). The raw URL arrays are dropped, so the model
 *   has no bare URL to paste and no "(example-air.example)" host to append.
 * - **Small samples are flagged.** A compare row whose Radar side has fewer
 *   than `SMALL_SAMPLE` reviews carries `small_sample: true`, and every compare
 *   result says how to read it.
 * - **Brand sources are named for what they are.** The brand list's `sources`
 *   (source-profile ids only) becomes `profile_sources`, with a note: a model
 *   read an empty `sources` as "the new connectors are not linked yet".
 *
 * Pure functions; anything unexpected passes through unchanged.
 */
import { isRecord } from '../../../lib/is-record.js';
import { clip } from '../format.js';

/** Fewer reviews than this in a category and a comparison is only indicative. */
const SMALL_SAMPLE = 10;
const MAX_TITLE_CHARS = 60;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const COMPARE_NOTE = 'Categories are OURS (their reviews are mapped onto our taxonomy). small_sample = fewer than '
  + `${SMALL_SAMPLE} of their reviews in that category: say the comparison is only indicative. When few of our `
  + 'categories hold their reviews, they make a different kind of product: say so before comparing.';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

/** The https spelling of a web URL, or undefined when it is not one. */
export function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function withoutTrailingSlashes(path: string): string {
  const trailing = path.length - path.split('').reverse().findIndex((char) => char !== '/');
  return trailing > path.length ? '' : path.slice(0, trailing);
}

/** Two URLs are one page when only the scheme, a leading `www.` or a trailing slash differ. */
function pageKey(url: string): string {
  const parsed = new URL(url);
  return `${hostOf(url)}${withoutTrailingSlashes(parsed.pathname)}${parsed.search}`;
}

/** "Jun 11" (this year), "Jun 11, 2025" (another year); "first found …" when the release published no date (the day the scan found it). */
export function shortDate(isoDate: unknown, approximate: unknown, thisYear: number): string | undefined {
  if (typeof isoDate !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(isoDate);
  if (!match) return undefined;
  const [, year = '', month = '', day = ''] = match;
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) return undefined;
  const label = Number(year) === thisYear ? `${name} ${Number(day)}` : `${name} ${Number(day)}, ${year}`;
  return approximate === true ? `first found ${label}` : label;
}

/** Link text: no brackets (they would end the link), no line breaks, short. */
function linkText(value: string): string {
  return clip(value.replaceAll(/[[\]\n\r]+/gu, ' ').replaceAll(/\s+/gu, ' ').trim(), MAX_TITLE_CHARS);
}

/** A real page title, or undefined when the API fell back to the host name. */
function realTitle(title: unknown, url: string): string | undefined {
  if (typeof title !== 'string' || !title.trim()) return undefined;
  const plain = title.trim().toLowerCase().replace(/^www\./u, '');
  return plain === hostOf(url) ? undefined : title;
}

function markdownLink(text: string, url: string): string {
  return `[${linkText(text)}](${url.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll(' ', '%20')})`;
}

interface LinkContext {
  seen: Set<string>;
  thisYear: number;
}

/** The first link reads "Feature · Jun 11"; the others their page title, or "Feature · source N". */
function citationText(position: number, lead: string, title: string | undefined, feature: string): string {
  if (position === 0) return lead;
  return title ?? `${linkText(feature)} · source ${position + 1}`;
}

function releaseLinks(release: Record<string, unknown>, context: LinkContext): string[] {
  const urls = Array.isArray(release.urls) ? release.urls : [];
  const titles = Array.isArray(release.titles) ? release.titles : [];
  const feature = typeof release.feature === 'string' && release.feature.trim() ? release.feature : 'Release';
  const date = shortDate(release.release_date, release.date_approximate, context.thisYear);
  const lead = date === undefined ? feature : `${linkText(feature)} · ${date}`;
  const links: string[] = [];
  for (const [index, raw] of urls.entries()) {
    const url = httpsUrl(raw);
    const key = url === undefined ? undefined : pageKey(url);
    if (url === undefined || key === undefined || context.seen.has(key)) continue;
    context.seen.add(key);
    links.push(markdownLink(citationText(links.length, lead, realTitle(titles[index], url), feature), url));
  }
  return links;
}

/** One release with `links` instead of its raw `urls` / `titles`. */
function shapeRelease(release: unknown, context: LinkContext): unknown {
  if (!isRecord(release)) return release;
  const rest = Object.fromEntries(Object.entries(release).filter(([key]) => key !== 'urls' && key !== 'titles'));
  return { ...rest, links: releaseLinks(release, context) };
}

/** A releases body (`{releases: [...]}`) with every release citing markdown links, deduped across the list. */
export function shapeReleases(body: unknown, nowMs: number): unknown {
  if (!isRecord(body) || !Array.isArray(body.releases)) return body;
  const context: LinkContext = { seen: new Set(), thisYear: new Date(nowMs).getUTCFullYear() };
  return { ...body, releases: body.releases.map((release) => shapeRelease(release, context)) };
}

function theirVolume(row: Record<string, unknown>): number | undefined {
  const theirs = row.theirs;
  return isRecord(theirs) && typeof theirs.volume === 'number' ? theirs.volume : undefined;
}

function shapeCompareRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const volume = theirVolume(row);
  return volume !== undefined && volume < SMALL_SAMPLE ? { ...row, small_sample: true } : row;
}

/** A compare body with small samples flagged and the reading note. */
export function shapeCompare(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.categories)) return body;
  return { ...body, categories: body.categories.map(shapeCompareRow), note: COMPARE_NOTE };
}

function shapeReview(review: unknown): unknown {
  if (!isRecord(review) || typeof review.url !== 'string') return review;
  const url = httpsUrl(review.url);
  return url === undefined ? { ...review, url: undefined } : { ...review, url };
}

/** Reviews (`{reviews: [...]}` or `{review}`) with https review links only. */
export function shapeReviews(body: unknown): unknown {
  if (!isRecord(body)) return body;
  if (Array.isArray(body.reviews)) return { ...body, reviews: body.reviews.map(shapeReview) };
  return 'review' in body ? { ...body, review: shapeReview(body.review) } : body;
}

export const BRANDS_NOTE = 'profile_sources lists only older source profiles that name the brand. Scrapers, review pages '
  + 'and app connectors created with radar_brand never appear there, so an empty list does not mean a brand has no '
  + 'source; list_scrapers lists every scraper, app connector and review page with the radar_brand it feeds. '
  + 'To see whether reviews arrived, call get_radar without a brand (each brand\u2019s review total) or '
  + 'get_source_run for an import.';

/** One brand of the list: `sources` (source-profile ids only) renamed so the model cannot read it as "connectors". */
function shapeBrand(brand: unknown): unknown {
  if (!isRecord(brand) || !('sources' in brand)) return brand;
  const { sources, ...rest } = brand;
  return { ...rest, profile_sources: sources };
}

/**
 * A brand list (view "brands", or the tracked brands without a brand) with each brand's source-profile ids
 * renamed and a note on reading them; unchanged when no brand carries `sources`.
 */
export function shapeBrands(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.brands)) return body;
  if (!body.brands.some((brand) => isRecord(brand) && 'sources' in brand)) return body;
  return { ...body, brands: body.brands.map(shapeBrand), note: BRANDS_NOTE };
}
