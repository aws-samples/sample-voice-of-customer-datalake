import { describe, expect, it } from 'vitest';

import { acceptKey, closePayload, encodeFrame, FrameError, FrameParser, OPCODE } from './ws-frames.js';
import { maskedFrame } from './ws-fixtures.js';

describe('acceptKey', () => {
  it('answers RFC 6455\'s own example key', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('FrameParser', () => {
  it('unmasks a frame that arrives in pieces, and reads several frames from one chunk', () => {
    const parser = new FrameParser(1024);
    const frame = maskedFrame(OPCODE.text, Buffer.from('hello'));
    expect(parser.push(frame.subarray(0, 3))).toStrictEqual([]);
    const frames = parser.push(Buffer.concat([frame.subarray(3), maskedFrame(OPCODE.binary, Buffer.from([1, 2]), false)]));
    expect(frames).toStrictEqual([
      { fin: true, opcode: OPCODE.text, payload: Buffer.from('hello') },
      { fin: false, opcode: OPCODE.binary, payload: Buffer.from([1, 2]) },
    ]);
  });

  it('reads a 16-bit length', () => {
    const payload = Buffer.alloc(300, 7);
    expect(new FrameParser(1024).push(maskedFrame(OPCODE.binary, payload))[0]?.payload).toStrictEqual(payload);
  });

  it('refuses a frame over the limit with 1009, before its payload arrives', () => {
    const header = maskedFrame(OPCODE.binary, Buffer.alloc(300)).subarray(0, 4);
    expect(() => new FrameParser(200).push(header)).toThrow(new FrameError(1009, 'frame too big'));
  });

  it('refuses a 64-bit length over the limit', () => {
    const header = Buffer.from([0x82, 0x80 | 127, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(() => new FrameParser(1024).push(header)).toThrow('frame too big');
  });

  it('refuses an unmasked frame, reserved bits and a long or fragmented control frame with 1002', () => {
    expect(() => new FrameParser(1024).push(Buffer.from([0x81, 0x01, 0x41]))).toThrow('client frame not masked');
    expect(() => new FrameParser(1024).push(Buffer.from([0xc1, 0x81, 0, 0, 0, 0, 0]))).toThrow('reserved bits set');
    expect(() => new FrameParser(1024).push(maskedFrame(OPCODE.ping, Buffer.alloc(126)))).toThrow('bad control frame');
    expect(() => new FrameParser(1024).push(maskedFrame(OPCODE.close, Buffer.alloc(2), false))).toThrow('bad control frame');
  });
});

describe('encodeFrame', () => {
  it('writes short, 16-bit and 64-bit lengths, never masked', () => {
    expect(encodeFrame(OPCODE.text, Buffer.from('hi'))).toStrictEqual(Buffer.from([0x81, 2, 0x68, 0x69]));
    expect(encodeFrame(OPCODE.binary, Buffer.alloc(300)).subarray(0, 4)).toStrictEqual(Buffer.from([0x82, 126, 1, 44]));
    expect(encodeFrame(OPCODE.binary, Buffer.alloc(70_000)).subarray(0, 10))
      .toStrictEqual(Buffer.from([0x82, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]));
  });

  it('closes with the code then the reason, the reason cut to fit a control frame', () => {
    expect(closePayload(1008, 'no')).toStrictEqual(Buffer.from([0x03, 0xf0, 0x6e, 0x6f]));
    expect(closePayload(1000, 'x'.repeat(200))).toHaveLength(125);
  });
});
