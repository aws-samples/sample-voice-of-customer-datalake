import { describe, expect, it } from 'vitest'
import { ignoreRejection, nullOnRejection } from './rejections'

describe('rejection handlers', () => {
  it('ignoreRejection settles a rejected promise as undefined', async () => {
    await expect(Promise.reject(new Error('offline')).catch(ignoreRejection)).resolves.toBeUndefined()
  })

  it('nullOnRejection settles a rejected promise as null', async () => {
    await expect(Promise.reject(new Error('not JSON')).catch(nullOnRejection)).resolves.toBeNull()
  })

  it('leaves a fulfilled value alone', async () => {
    await expect(Promise.resolve('kept').catch(nullOnRejection)).resolves.toBe('kept')
  })
})
