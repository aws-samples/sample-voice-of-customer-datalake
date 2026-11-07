/**
 * A dimension key and value as lambda/shared/dimension_config.py accepts them (DIMENSION_KEY_RE,
 * DIMENSION_VALUE_RE). Read by the item filters (`server/item-filters.ts`, `server/core.ts`) and the
 * label fields of the write tools (`client/allowlists.ts`, which the SPA imports through `@stream`), so
 * this module holds nothing but the two patterns.
 */
export const DIMENSION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const DIMENSION_VALUE_PATTERN = /^[^\s#,:]{1,64}$/;
