/**
 * @fileoverview Whose S3 import files the explorer works on, and the query keys it caches them under.
 *
 * The S3 import API acts in the workspace `X-Workspace-Id` names (its `ws/{ws}/` folder) and, without the header, in
 * the deployment's (7.86.00). The explorer sends its card's scope (workspace/configScope.ts): in `'workspace'` the
 * current workspace's files (the deployment's outside every workspace, where no header is sent), in `'deployment'`
 * the deployment's from anywhere. Every key carries that place after its root, so a switch of workspace or scope never
 * shows another place's cached sources, files or runs, and an invalidation of a root still reaches every place.
 *
 * @module components/S3ImportExplorer/s3ImportPlace
 */
import { S3_IMPORT_REPROCESS_ROOT } from '../../api/s3ImportReprocessApi'
import type { RequestScope } from '../../api/baseUrl'
import { useConfigScope } from '../../workspace/configScope'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'

/** Query-key roots of the place's sources and files lists (api/queryPolicies.ts, api/feedbackDataWatch.ts). */
const S3_IMPORT_SOURCES_ROOT = 's3-import-sources'

const S3_IMPORT_FILES_ROOT = 's3-import-files'

/** The place's part of a key: the workspace's id, or the deployment's (`null`: no header is sent). */
type PlaceParts = readonly ['workspace', string] | readonly ['deployment', null]

export interface S3ImportPlace {
  /** The scope every call of the explorer is sent in. */
  readonly scope: RequestScope
  readonly sourcesKey: () => readonly unknown[]
  /** `source` omitted: every source's list of this place (the invalidation's prefix). */
  readonly filesKey: (...source: readonly [] | readonly [string]) => readonly unknown[]
  readonly runKey: (runId: string) => readonly unknown[]
}

/** The place a call in `scope` reaches while the app is in `workspaceId` (null: in none). */
function placeParts(scope: RequestScope, workspaceId: string | null): PlaceParts {
  return scope === 'workspace' && workspaceId !== null ? ['workspace', workspaceId] : ['deployment', null]
}

/** The scope and the keys of the explorer's place: its card's scope, in the workspace the app is in. */
export function useS3ImportPlace(): S3ImportPlace {
  const scope = useConfigScope()
  const parts = placeParts(scope, useCurrentWorkspace()?.id ?? null)
  return {
    scope,
    sourcesKey: () => [S3_IMPORT_SOURCES_ROOT, ...parts],
    filesKey: (...source) => [S3_IMPORT_FILES_ROOT, ...parts, ...source],
    runKey: (runId) => [S3_IMPORT_REPROCESS_ROOT, ...parts, runId],
  }
}
