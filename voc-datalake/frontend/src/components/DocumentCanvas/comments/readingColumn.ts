/**
 * @fileoverview How a document reads on the page, commented or not: the column it sits in (about 70
 * characters wide) and the canvas's reading typography. The page's plain canvas and the commented
 * one (PR/FAQ, PRD, the review page) take both from here, so every kind of document reads alike.
 *
 * @module components/DocumentCanvas/comments/readingColumn
 */

/** The reading column: never wider than ~70 characters, and it may shrink to the screen. */
export const READING_COLUMN_CLASS = 'min-w-0 max-w-[70ch]'

/** The canvas's reading typography (the Markdown styles, a roomier line height). */
export const READING_TEXT_CLASS = 'md-content leading-7!'
