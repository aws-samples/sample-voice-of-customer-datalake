/**
 * @fileoverview What an S3 import key names: its file and the `S3 - <folder>` source
 * the ingestor files its rows under (plugins/s3_import/ingestor/handler.py
 * `_get_source_from_key`). A copy archived as `processed/<folder>/<file>` keeps the
 * folder of its original upload, as a reprocess does (issue #144).
 *
 * @module components/S3ImportExplorer/importKey
 */

const PROCESSED_FOLDER = 'processed'
/** The ingestor's label for a key with no folder (`_get_source_from_key`). */
const ROOT_SOURCE = 'S3 - Import'

export function describeImportKey(key: string): { filename: string; source: string } {
  const parts = key.split('/')
  const [folder, ...rest] = parts[0] === PROCESSED_FOLDER && parts.length > 2 ? parts.slice(1) : parts
  const source = folder !== undefined && rest.length > 0 ? `S3 - ${folder}` : ROOT_SOURCE
  return { filename: parts.at(-1) ?? key, source }
}
