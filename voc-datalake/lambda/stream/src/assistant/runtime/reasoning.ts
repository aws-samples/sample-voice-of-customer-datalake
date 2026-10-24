/**
 * Round-trip of Claude reasoning blocks through AG-UI `encryptedValue`.
 *
 * While a tool loop is in progress Claude requires the LAST tool-using
 * assistant turn to be replayed with its thinking block unmodified (text +
 * signature, or the redacted bytes). Within one run the runtime keeps the
 * blocks itself; across an approval interrupt the thread is resumed by the SPA,
 * so the blocks travel as an AG-UI `REASONING_ENCRYPTED_VALUE` event
 * (subtype `message`, entityId = the assistant message id) that the SPA stores
 * on `AssistantMessage.encryptedValue` and sends back.
 *
 * The value is opaque to the SPA: base64 of a small JSON document. Integrity
 * is Bedrock's: a tampered signature is rejected by the model provider, and the
 * runtime then falls back to a text-only tail (see loop.ts).
 */
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';

const VERSION = 1;

const encodedSchema = z.object({
  v: z.literal(VERSION),
  blocks: z.array(z.union([
    z.object({ kind: z.literal('text'), text: z.string(), signature: z.string().optional() }),
    z.object({ kind: z.literal('redacted'), data: z.string() }),
  ])).min(1),
});

type EncodedBlock = z.infer<typeof encodedSchema>['blocks'][number];

function toEncoded(block: ContentBlock): EncodedBlock[] {
  const reasoning = block.reasoningContent;
  if (!reasoning) return [];
  if (reasoning.redactedContent) {
    return [{ kind: 'redacted', data: Buffer.from(reasoning.redactedContent).toString('base64') }];
  }
  if (reasoning.reasoningText) {
    const { text, signature } = reasoning.reasoningText;
    return [{ kind: 'text', text: text ?? '', ...(signature ? { signature } : {}) }];
  }
  return [];
}

/** Encode the reasoning blocks of an assistant turn, or undefined when it has none. */
export function encodeReasoning(content: readonly ContentBlock[]): string | undefined {
  const blocks = content.flatMap(toEncoded);
  if (blocks.length === 0) return undefined;
  return Buffer.from(JSON.stringify({ v: VERSION, blocks }), 'utf8').toString('base64');
}

function fromEncoded(block: EncodedBlock): ContentBlock {
  if (block.kind === 'redacted') {
    return { reasoningContent: { redactedContent: Buffer.from(block.data, 'base64') } };
  }
  return {
    reasoningContent: {
      reasoningText: { text: block.text, ...(block.signature ? { signature: block.signature } : {}) },
    },
  };
}

/** Decode an `encryptedValue`; anything unreadable yields []. */
export function decodeReasoning(value: string | undefined): ContentBlock[] {
  if (!value) return [];
  try {
    const json: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const parsed = encodedSchema.safeParse(json);
    return parsed.success ? parsed.data.blocks.map(fromEncoded) : [];
  } catch {
    return [];
  }
}
