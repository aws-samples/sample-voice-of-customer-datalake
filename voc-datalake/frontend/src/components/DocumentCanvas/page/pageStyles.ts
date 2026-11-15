/**
 * @fileoverview The document page's wiki look, shared by the page and the blank draft pane: a wide centred sheet
 * (generous width, the text itself held to a comfortable ~70 characters by the reading column) and a large title
 * typed over in place. Design-system tokens only, so the dark and the light theme both hold.
 *
 * @module components/DocumentCanvas/page/pageStyles
 */

/** The sheet the title, its details and the text sit on: centred, wide, with room around it. */
export const PAGE_SHEET_CLASS = 'mx-auto w-full max-w-[76rem] px-4 py-6 sm:px-6 sm:py-8 2xl:px-10'

/** The sheet in full width (View → Full width): no cap, the same room around it. */
export const PAGE_SHEET_WIDE_CLASS = 'w-full px-4 py-6 sm:px-6 sm:py-8 2xl:px-10'

/** The title's type: large, tight, the strongest text on the page. */
const TITLE_TYPE = 'text-2xl sm:text-4xl font-bold tracking-tight leading-tight text-text-strong'

/** The title read only (a viewer, a PRD / PR/FAQ whose title is its series'). */
export const TITLE_TEXT_CLASS = `min-w-0 break-words ${TITLE_TYPE}`

/** The title as an inline field: reads as the heading, shows its edge on hover and its ring on focus. */
export const TITLE_INPUT_CLASS = `block w-full min-w-0 -mx-1.5 px-1.5 rounded-md border border-transparent bg-transparent ${TITLE_TYPE}
  hover:border-border focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring
  aria-invalid:border-danger`
