/**
 * @fileoverview The chat composer's submit rule, stated once.
 *
 * Lives in its own module rather than in Chat.tsx because a non-component export
 * from a .tsx file trips `react-refresh/only-export-components`, which the lint
 * gate treats as an error.
 *
 * The rule used to be duplicated between the send button's `disabled` and the
 * submit handler's early return. That is how Enter bypasses a disabled button, so
 * both now consult this.
 *
 * @module pages/Chat/composerState
 */
import { MAX_CHAT_MESSAGE_LENGTH } from '../../api/streamLimits'

export interface ComposerState {
  /** Input exceeds what the stream Lambda will accept. */
  readonly isTooLong: boolean
  /** Everything the composer requires before a send may be attempted. */
  readonly canSubmit: boolean
}

export function composerState(input: string, isStreaming: boolean): ComposerState {
  const isTooLong = input.length > MAX_CHAT_MESSAGE_LENGTH
  return {
    isTooLong,
    canSubmit: input.trim() !== '' && !isTooLong && !isStreaming,
  }
}
