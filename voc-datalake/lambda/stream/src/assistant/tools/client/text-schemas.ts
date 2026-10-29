/**
 * Text field schemas the client-tool argument schemas share. Mirrored by the SPA's
 * `assistant/approvals/schemas.ts` (`optionalNonEmpty`), so a card re-checks an
 * argument with the same rule the tool declared.
 */
import { z } from 'zod';

/** An optional string that, when given, is non-blank after trimming and at most `max` characters. */
export const optionalNonEmpty = (max: number) => z.string().trim().min(1).max(max).optional();
