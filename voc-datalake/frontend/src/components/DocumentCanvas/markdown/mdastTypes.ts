/**
 * The three node types the canvas adds to mdast while it serialises (never stored, never parsed):
 * - `rawBlock` / `rawInline`: Markdown the editor has no node for (HTML, footnotes, definitions, references …),
 *   kept as its exact source and written back verbatim;
 * - `verbatim`: a top-level block the user did not change, written back as the stored source slice.
 * Imported for its side effect (the module augmentation) by the files that build these nodes.
 */
import type { Literal } from 'mdast'

interface RawBlock extends Literal { type: 'rawBlock' }
interface RawInline extends Literal { type: 'rawInline' }
interface Verbatim extends Literal { type: 'verbatim' }

declare module 'mdast' {
  interface RootContentMap { rawBlock: RawBlock; rawInline: RawInline; verbatim: Verbatim }
  interface BlockContentMap { rawBlock: RawBlock; verbatim: Verbatim }
  interface PhrasingContentMap { rawInline: RawInline }
}
