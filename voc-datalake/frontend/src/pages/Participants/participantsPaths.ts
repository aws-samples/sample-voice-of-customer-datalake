/**
 * @fileoverview Participants' tabs as paths (7.49.00, utils/tabPaths.ts): `/participants/lists` (`/participants` too),
 * `/participants/people`, `/participants/asks`.
 *
 * @module pages/Participants/participantsPaths
 */
import type { TabPage } from '../../utils/tabPaths'

export const PARTICIPANT_TABS = ['lists', 'people', 'asks'] as const
export type ParticipantTab = typeof PARTICIPANT_TABS[number]

export const PARTICIPANTS_PAGE: TabPage<ParticipantTab> = { base: '/participants', tabs: PARTICIPANT_TABS }
