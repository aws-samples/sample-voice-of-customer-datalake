/**
 * A workspace's id, as the Python side spells it.
 *
 * @module lib/workspace-id
 */

/** LOCKSTEP with lambda/shared/workspace_ids.py `WORKSPACE_ID_TEXT`: `ws_` + a ULID. */
export const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
