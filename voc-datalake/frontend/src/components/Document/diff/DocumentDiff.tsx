/**
 * @fileoverview Two versions of a text compared, one look for every compare: rendered as the document reads by
 * default (BlockDiff: added and removed blocks), or the Source line diff (TextDiff). Past the diff caps either view
 * falls back as it always did (the full text, or the start of each side side by side).
 *
 * @module components/Document/diff/DocumentDiff
 */
import BlockDiff from './BlockDiff'
import TextDiff from './TextDiff'
import { TextViews } from '../read/ViewToggle'
import type { MarkdownPolicy } from '../read/markdownPolicy'

interface DocumentDiffProps {
  readonly before: string
  readonly after: string
  readonly policy: MarkdownPolicy
  /** Said when the two are the same. */
  readonly identicalText: string
  /** The sides' names ("v2", "Current"), for the side-by-side fallback. */
  readonly beforeLabel: string
  readonly afterLabel: string
}

export default function DocumentDiff({ before, after, policy, identicalText, beforeLabel, afterLabel }: DocumentDiffProps) {
  return (
    <TextViews rendered={<BlockDiff before={before} after={after} policy={policy} identicalText={identicalText} />}
      source={<TextDiff before={before} after={after} identicalText={identicalText} beforeLabel={beforeLabel} afterLabel={afterLabel} />} />
  )
}
