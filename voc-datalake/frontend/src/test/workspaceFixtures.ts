/**
 * @fileoverview The two fictional workspaces the workspace specs share, as `GET /me/workspaces` lists them
 * (the dev mock's, mock-workspaces.js: ids in the server's `ws_` + ULID form).
 */
import type { CurrentWorkspace } from '../workspace/currentWorkspace'

export const ACME: CurrentWorkspace = { id: 'ws_01JCACME0000000000000000A1', name: 'Acme Outfitters', slug: 'acme', role: 'admin' }
export const JUNIPER: CurrentWorkspace = { id: 'ws_01JCJNPR0000000000000000J1', name: 'Juniper Trail Co.', slug: 'juniper', role: 'editor' }
