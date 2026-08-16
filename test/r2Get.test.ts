import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { isR2TransientError, r2Get } from '../src/cache/r2Get'
import { describeError } from '../src/util/errors'
import type { Env } from '../src/config'

// R2's transient InternalError as workerd surfaces it: a plain Error whose
// message carries the operation and the numeric code (seen live from
// STORAGE.get during a packument rebuild).
const r2InternalError = () =>
  new Error('get: We encountered an internal error. Please try again. (10001)')

function envWithGet(get: (key: string) => Promise<unknown>): Env {
  return { STORAGE: { get } } as unknown as Env
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isR2TransientError', () => {
  it('matches the 10001 InternalError message', () => {
    expect(isR2TransientError(r2InternalError())).toBe(true)
    expect(
      isR2TransientError(
        new Error('put: We encountered an internal error. Please try again. (10001)'),
      ),
    ).toBe(true)
  })

  it('rejects other errors and non-errors', () => {
    expect(isR2TransientError(new Error('get: The specified object does not exist. (10007)'))).toBe(
      false,
    )
    expect(isR2TransientError(new Error('network timeout'))).toBe(false)
    expect(isR2TransientError('(10001)')).toBe(false)
    expect(isR2TransientError(undefined)).toBe(false)
  })
})

describe('r2Get', () => {
  it('returns the object without retrying on success', async () => {
    const obj = { body: 'bytes' }
    const get = vi.fn(async () => obj)
    const result = await r2Get(envWithGet(get), 'meta/pkg/1.0.0')
    expect(result).toBe(obj)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('retries once on 10001 and returns the second result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const obj = { body: 'bytes' }
    const get = vi.fn().mockRejectedValueOnce(r2InternalError()).mockResolvedValueOnce(obj)
    const result = await r2Get(envWithGet(get), 'meta/pkg/1.0.0')
    expect(result).toBe(obj)
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenNthCalledWith(2, 'meta/pkg/1.0.0')
    // The retry itself is logged with the key and the full error detail.
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = warn.mock.calls[0].join(' ')
    expect(logged).toContain('meta/pkg/1.0.0')
    expect(logged).toContain('(10001)')
  })

  it('does not retry non-transient errors', async () => {
    const notFound = new Error('get: The specified bucket does not exist. (10006)')
    const get = vi.fn().mockRejectedValue(notFound)
    await expect(r2Get(envWithGet(get), 'meta/pkg/1.0.0')).rejects.toBe(notFound)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('rethrows with the key attached when the retry also fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = r2InternalError()
    const get = vi.fn().mockRejectedValueOnce(r2InternalError()).mockRejectedValueOnce(second)
    const err = await r2Get(envWithGet(get), 'meta/pkg/1.0.0').then(
      () => {
        throw new Error('expected r2Get to reject')
      },
      (e: unknown) => e as Error,
    )
    expect(get).toHaveBeenCalledTimes(2)
    expect(err.message).toContain('meta/pkg/1.0.0')
    expect(err.message).toContain('failed after retry')
    expect(err.message).toContain('(10001)')
    expect(err.cause).toBe(second)
  })
})

describe('describeError', () => {
  it('includes the stack (name + message) of the error', () => {
    const detail = describeError(new Error('boom'))
    expect(detail).toContain('Error: boom')
    expect(detail).toContain('at ') // stack frames
  })

  it('walks the cause chain', () => {
    const root = r2InternalError()
    const wrapped = new Error('R2 get meta/pkg/1.0.0 failed after retry', {
      cause: root,
    })
    const detail = describeError(wrapped)
    expect(detail).toContain('failed after retry')
    expect(detail).toContain('Caused by:')
    expect(detail).toContain('(10001)')
  })

  it('stringifies non-Error values', () => {
    expect(describeError('plain string')).toBe('plain string')
    expect(describeError(undefined)).toBe('undefined')
  })
})
