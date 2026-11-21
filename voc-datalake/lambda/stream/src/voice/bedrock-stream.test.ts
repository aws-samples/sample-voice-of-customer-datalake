import { describe, expect, it, vi } from 'vitest';

import { bedrockTransport, isBusyError, SonicStream, SonicStreamError } from './bedrock-stream.js';
import { FakeTransport, settle } from './voice-fixtures.js';

interface Chunk {
  chunk: { bytes: Uint8Array };
}

interface SdkState {
  sent: Array<{ modelId: string; body: AsyncIterable<Chunk> }>;
  regions: string[];
  answer: unknown;
}

const sdk = vi.hoisted((): SdkState => ({ sent: [], regions: [], answer: undefined }));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    constructor(config: { region: string }) {
      sdk.regions.push(config.region);
    }

    send(command: { input: { modelId: string; body: AsyncIterable<Chunk> } }) {
      sdk.sent.push(command.input);
      return Promise.resolve(sdk.answer);
    }
  },
  InvokeModelWithBidirectionalStreamCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function members<T>(...items: T[]): AsyncIterable<T> {
  return (async function* listed() {
    for (const item of items) yield await Promise.resolve(item);
  })();
}

describe('SonicStream', () => {
  it('sends what was pushed before the model connected, in order, then the close, and nothing after', async () => {
    const transport = new FakeTransport();
    const stream = new SonicStream(0, 0);
    stream.send({ event: { sessionStart: {} } });
    await stream.start(transport);
    stream.send([{ event: { audioInput: {} } }]);
    stream.close();
    stream.send({ event: { audioInput: {} } });
    stream.close();
    await settle();
    expect(transport.stream(0).names()).toStrictEqual(['sessionStart', 'audioInput', 'contentEnd', 'promptEnd', 'sessionEnd']);
    expect(transport.stream(0).inputEnded).toBe(true);
  });

  it('names each content block once', () => {
    const stream = new SonicStream(1, 0);
    expect([stream.contentName('tool'), stream.contentName('tool'), stream.contentName('goodbye')])
      .toStrictEqual(['voc-tool-1', 'voc-tool-2', 'voc-goodbye-3']);
  });

  it('parses the model\'s output', async () => {
    const transport = new FakeTransport();
    const output = await new SonicStream(0, 0).start(transport);
    transport.stream(0).emit('textOutput', { contentId: 'c', role: 'USER', content: 'hi' });
    transport.stream(0).output.end();
    const events = [];
    for await (const event of output) events.push(event);
    expect(events).toStrictEqual([{ kind: 'text', contentId: 'c', role: 'USER', content: 'hi' }]);
  });
});

describe('bedrockTransport', () => {
  it('invokes the one model in its region and wraps each input event as a chunk', async () => {
    sdk.answer = { body: members({ chunk: { bytes: encode({ event: {} }) } }, { chunk: {} }) };
    const output = await bedrockTransport('amazon.nova-2-5-sonic', 'us-west-2').open(members(encode({ a: 1 })));
    const received = [];
    for await (const bytes of output) received.push(new TextDecoder().decode(bytes));
    const chunks = [];
    for await (const chunk of sdk.sent[0]?.body ?? members<Chunk>()) chunks.push(new TextDecoder().decode(chunk.chunk.bytes));
    expect([sdk.regions[0], sdk.sent[0]?.modelId]).toStrictEqual(['us-west-2', 'amazon.nova-2-5-sonic']);
    expect(chunks).toStrictEqual(['{"a":1}']);
    expect(received).toStrictEqual(['{"event":{}}']);
  });

  it('ends the output with the exception the stream answered, by its service name', async () => {
    sdk.answer = { body: members({ throttlingException: { message: 'slow down' } }) };
    const output = await bedrockTransport('amazon.nova-2-5-sonic', 'us-west-2').open(members());
    const drained: Uint8Array[] = [];
    const read = async () => {
      for await (const bytes of output) drained.push(bytes);
    };
    await expect(read()).rejects.toThrow(new SonicStreamError('ThrottlingException'));
    expect(drained).toStrictEqual([]);
  });

  it('fails when the response has no stream', async () => {
    sdk.answer = {};
    await expect(bedrockTransport('m', 'us-west-2').open(members())).rejects.toThrow('EmptyStream');
  });
});

describe('isBusyError', () => {
  it('counts throttling, the quota and a model stream error as busy, nothing else', () => {
    expect(['ThrottlingException', 'ServiceQuotaExceededException', 'ModelStreamErrorException']
      .map((name) => isBusyError(new SonicStreamError(name)))).toStrictEqual([true, true, true]);
    expect([isBusyError(new SonicStreamError('ValidationException')), isBusyError('ThrottlingException')]).toStrictEqual([false, false]);
  });
});
