/**
 * Text field schemas the client-tool argument schemas share. The SPA's approval cards import
 * them through `@stream`, so a card re-checks an argument with the same rule the tool declared.
 * Pure (zod only): it runs in the browser bundle (eslint `browser-safe` block).
 */
import { z } from 'zod';

/** A string that is non-blank after trimming and at most `max` characters. */
export const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

/** An optional string that, when given, is non-blank after trimming and at most `max` characters. */
export const optionalNonEmpty = (max: number) => nonEmpty(max).optional();

/** A calendar date argument (`YYYY-MM-DD`). */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
