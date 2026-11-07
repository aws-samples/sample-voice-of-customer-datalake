/**
 * streamSource.ts dedupes `zod`, so the stream modules the SPA imports through `@stream` run on the SPA's copy.
 * That is only safe while both packages pin the same exact zod version; this fails when one moves alone.
 */
import { describe, it, expect } from 'vitest'
import spaPackage from '../../package.json'
import streamPackage from '../../../lambda/stream/package.json'

describe('the zod the SPA dedupes', () => {
  it('is pinned to the same exact version in the SPA and the stream Lambda', () => {
    expect(spaPackage.dependencies.zod).toMatch(/^\d+\.\d+\.\d+$/)
    expect(streamPackage.dependencies.zod).toBe(spaPackage.dependencies.zod)
  })
})
