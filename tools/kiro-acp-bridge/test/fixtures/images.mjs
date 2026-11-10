// Minimal image byte builders: valid headers with chosen dimensions, padded to a chosen size.
// The bridge reads only the header, so pixel data is irrelevant.

function pad(header, totalBytes) {
  return totalBytes > header.length ? Buffer.concat([header, Buffer.alloc(totalBytes - header.length)]) : header
}

export function png(width, height, totalBytes = 64) {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return pad(header, totalBytes)
}

export function gif(width, height) {
  const header = Buffer.alloc(13)
  header.write('GIF89a', 0, 'latin1')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  return header
}

/** JPEG with an APP0 segment before the SOF0 frame header, as real files have. */
export function jpeg(width, height, sofMarker = 0xc0, totalBytes = 0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = sofMarker
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return pad(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]), totalBytes)
}

function riff(chunk, body) {
  const header = Buffer.alloc(20)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(12 + body.length, 4)
  header.write('WEBP', 8, 'latin1')
  header.write(chunk, 12, 'latin1')
  header.writeUInt32LE(body.length, 16)
  return Buffer.concat([header, body])
}

export function webpVp8x(width, height) {
  const body = Buffer.alloc(10)
  body.writeUIntLE(width - 1, 4, 3)
  body.writeUIntLE(height - 1, 7, 3)
  return riff('VP8X', body)
}

export function webpVp8l(width, height) {
  const body = Buffer.alloc(10)
  body[0] = 0x2f
  const w = width - 1
  const h = height - 1
  body[1] = w & 0xff
  body[2] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6)
  body[3] = (h >> 2) & 0xff
  body[4] = (h >> 10) & 0x0f
  return riff('VP8L', body)
}

export function webpVp8(width, height) {
  const body = Buffer.alloc(10)
  body[3] = 0x9d
  body[4] = 0x01
  body[5] = 0x2a
  body.writeUInt16LE(width, 6)
  body.writeUInt16LE(height, 8)
  return riff('VP8 ', body)
}

export const b64 = (buf) => buf.toString('base64')
