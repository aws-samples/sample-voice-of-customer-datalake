/**
 * @fileoverview A stand-in for `BroadcastChannel` in specs of the preview window (preview/previewChannel.ts): the
 * channels of one name hear each other's messages (never their own), at once, as copies; a closed channel hears
 * nothing. `vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)`, and `FakeBroadcastChannel.reset()` after each.
 *
 * @module pages/FeedbackForms/test/fakeBroadcastChannel
 */
export class FakeBroadcastChannel {
  static readonly open = new Set<FakeBroadcastChannel>()
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  readonly name: string

  constructor(name: string) {
    this.name = name
    FakeBroadcastChannel.open.add(this)
  }

  postMessage(data: unknown): void {
    if (!FakeBroadcastChannel.open.has(this)) throw new Error('The channel is closed.')
    for (const other of FakeBroadcastChannel.open) {
      if (other !== this && other.name === this.name) other.onmessage?.(new MessageEvent('message', { data: structuredClone(data) }))
    }
  }

  close(): void {
    FakeBroadcastChannel.open.delete(this)
  }

  /** The channels of `name` still open. */
  static named(name: string): FakeBroadcastChannel[] {
    return [...FakeBroadcastChannel.open].filter((channel) => channel.name === name)
  }

  static reset(): void {
    FakeBroadcastChannel.open.clear()
  }
}

/** A listener on `name`, as the other side would be: the messages it heard, in order. */
export function listen(name: string): { readonly channel: FakeBroadcastChannel; readonly heard: unknown[] } {
  const channel = new FakeBroadcastChannel(name)
  const heard: unknown[] = []
  channel.onmessage = (event) => heard.push(event.data)
  return { channel, heard }
}
