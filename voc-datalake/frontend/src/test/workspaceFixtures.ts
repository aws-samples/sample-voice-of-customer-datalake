/**
 * @fileoverview The two fictional workspaces the workspace specs share, as `GET /me/workspaces` lists them
 * (the dev mock's, mock-workspaces.js: ids in the server's `ws_` + ULID form).
 */
import type { CurrentWorkspace } from '../workspace/currentWorkspace'

const ACME_ID = 'ws_01JCACME0000000000000000A1'
export const ACME: CurrentWorkspace = { id: ACME_ID, name: 'Acme Outfitters', slug: 'acme', role: 'admin' }
/** Acme as the platform console lists it (`GET /platform/workspaces`). */
export const PLATFORM_ACME = { id: ACME_ID, name: 'Acme Outfitters', slug: 'acme', status: 'active', created_at: '2026-10-13T09:00:00Z', secret_status: 'ready' }

export const JUNIPER: CurrentWorkspace = { id: 'ws_01JCJNPR0000000000000000J1', name: 'Juniper Trail Co.', slug: 'juniper', role: 'editor' }
