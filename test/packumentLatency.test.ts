import { createExecutionContext, env as bindings, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { KV_READ_TIMEOUT_MS, kvCached, kvCachedText } from '../src/cache/kvCache'
import { metaIndexKey, metaKey, REFS_INDEX_KEY } from '../src/cache/r2Cache'
import { fetchNpmPackument, NPM_FETCH_TIMEOUT_MS } from '../src/registry/fetchNpmPackument'
import { getPackumentBody, PACKUMENT_TIMEOUT_MS } from '../src/registry/getPackumentBody'
import { RequestTiming, type RequestWork } from '../src/util/requestTiming'
import type { Env } from '../src/config'
import { app } from '../src/app'

const env: Env = {
  ...bindings,
  PUBLIC_BASE_URL: 'https://bridge.example.com',
  NPM_REGISTRY: 'https://registry.npmjs.org',
  PREVIEW_OWNER: 'voidzero-dev',
  PREVIEW_REPO: 'vite-plus',
  WORKSPACE_PACKAGES: 'vite-plus,@voidzero-dev/vite-plus-*',
}

// Select the single-key overload instead of Vitest's default (the final,
// bulk-read overload returning a Map).
const kv = env.KV as { get: (key: string, type: 'json' | 'text') => Promise<unknown> }
const log = vi.fn()
const warn = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function requestWork() {
  return {
    executionCtx: createExecutionContext(),
    timing: new RequestTiming(),
    signal: new AbortController().signal,
  } satisfies RequestWork
}

beforeEach(() => {
  log.mockClear()
  warn.mockClear()
  vi.spyOn(console, 'log').mockImplementation(log)
  vi.spyOn(console, 'warn').mockImplementation(warn)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('optional KV cache I/O', () => {
  it.each(['json', 'text'] as const)(
    'returns %s data while a cache write is still pending',
    async (format) => {
      vi.spyOn(kv, 'get').mockResolvedValue(null)
      const write = deferred<void>()
      const put = vi.spyOn(env.KV, 'put').mockReturnValue(write.promise)
      const work = requestWork()
      try {
        const value =
          format === 'json'
            ? await kvCached(env, 'latency', 60, async () => ({ stable: true }), work)
            : await kvCachedText(env, 'latency', 60, async () => 'ready', work)
        expect(value).toEqual(format === 'json' ? { stable: true } : 'ready')
        expect(put).toHaveBeenCalledOnce()
        if (typeof value === 'object' && value) {
          // The caller injects previews after this returns. Those mutations must
          // not leak into the npm-only cache populated in the background.
          value.stable = false
          expect(put.mock.calls[0][1]).toBe('{"stable":true}')
        }
      } finally {
        write.resolve()
        await waitOnExecutionContext(work.executionCtx)
      }
    },
  )

  it('bypasses a stalled cache read and handles its late rejection', async () => {
    vi.useFakeTimers()
    const read = deferred<null>()
    vi.spyOn(kv, 'get').mockReturnValue(read.promise)
    vi.spyOn(env.KV, 'put').mockResolvedValue()
    const fetcher = vi.fn(async () => 'fresh')
    const work = requestWork()
    const result = kvCachedText(env, 'latency', 60, fetcher, work)
    await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS - 1)
    expect(fetcher).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('fresh')
    expect(work.timing.cache.latency).toBe('bypass')
    read.reject(new Error('late KV failure'))
    await waitOnExecutionContext(work.executionCtx)
  })

  it('logs a background write failure without failing the response', async () => {
    vi.spyOn(kv, 'get').mockResolvedValue(null)
    vi.spyOn(env.KV, 'put').mockRejectedValue(new Error('KV unavailable'))
    const work = requestWork()
    expect(await kvCachedText(env, 'latency', 60, async () => 'ready', work)).toBe('ready')
    await waitOnExecutionContext(work.executionCtx)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KV unavailable'))
  })
})

describe('npm deadlines', () => {
  it.each(['headers', 'body'] as const)(
    'aborts when npm stalls while reading %s',
    async (phase) => {
      vi.useFakeTimers()
      let signal: AbortSignal | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal ?? undefined
          if (phase === 'headers') {
            return new Promise<Response>((_, reject) => {
              signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
            })
          }
          const response = Response.json({})
          vi.spyOn(response, 'json').mockImplementation(
            () =>
              new Promise((_, reject) => {
                signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
              }),
          )
          return Promise.resolve(response)
        }),
      )
      const result = fetchNpmPackument(env, 'vite-plus').catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(NPM_FETCH_TIMEOUT_MS)
      expect(await result).toMatchObject({
        status: 504,
        message: expect.stringContaining('npm metadata request timed out'),
      })
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('propagates the enclosing request cancellation to npm', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
        })
      }),
    )
    const result = fetchNpmPackument(env, 'vite-plus', controller.signal).catch(
      (err: unknown) => err,
    )
    const error = new Error('request deadline')
    controller.abort(error)
    expect(await result).toBe(error)
    expect(signal?.aborted).toBe(true)
  })
})

describe('packument response budget', () => {
  it('serves a cached response with one R2 read and one KV read', async () => {
    vi.useFakeTimers()
    const get = vi.spyOn(env.STORAGE, 'get').mockResolvedValue(null)
    const body = '{"name":"vite-plus","versions":{}}'
    const read = vi.spyOn(kv, 'get').mockResolvedValue(body)
    const put = vi.spyOn(env.KV, 'put')
    const npm = vi.fn()
    vi.stubGlobal('fetch', npm)
    const ctx = createExecutionContext()
    expect(await getPackumentBody(env, 'vite-plus', ctx)).toBe(body)
    expect(get).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(put).not.toHaveBeenCalled()
    expect(npm).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await waitOnExecutionContext(ctx)
  })

  it('returns HTTP 504 for stalled npm without caching an incomplete packument', async () => {
    vi.useFakeTimers()
    vi.spyOn(env.STORAGE, 'get').mockResolvedValue(null)
    vi.spyOn(kv, 'get').mockResolvedValue(null)
    const put = vi.spyOn(env.KV, 'put')
    const started = deferred<void>()
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init!.signal!
        signals.push(signal)
        if (signals.length === 2) started.resolve()
        return new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }),
    )
    const ctx = createExecutionContext()
    const response = app.fetch(new Request('https://bridge.example.com/vite-plus'), env, ctx)
    await started.promise
    await vi.advanceTimersByTimeAsync(NPM_FETCH_TIMEOUT_MS)
    const res = await response
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'npm metadata request timed out for vite-plus' })
    expect(put).not.toHaveBeenCalled()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await waitOnExecutionContext(ctx)
  })

  it.each([0, 1])(
    'serves 176 refs with only %i per-version fallback reads and no awaited writes',
    async (missing) => {
      const refs: Record<string, unknown> = {}
      const metas: Record<string, unknown> = {}
      for (let i = 0; i < 176; i++) {
        const sha = i.toString(16).padStart(7, '0')
        const version = `0.0.0-commit.${sha}`
        refs[`commit.${sha}`] = { expiresAt: Date.now() + 60_000 }
        const meta = { packageJson: { name: 'vite-plus', version }, shasum: '', integrity: '' }
        if (i < missing) await env.STORAGE.put(metaKey('vite-plus', version), JSON.stringify(meta))
        else metas[version] = meta
      }
      await env.STORAGE.put(REFS_INDEX_KEY, JSON.stringify(refs))
      await env.STORAGE.put(metaIndexKey('vite-plus'), JSON.stringify(metas))
      const get = vi.spyOn(env.STORAGE, 'get')
      vi.spyOn(kv, 'get').mockResolvedValue(null)
      const write = deferred<void>()
      const put = vi.spyOn(env.KV, 'put').mockReturnValue(write.promise)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ name: 'vite-plus', versions: {}, time: {} })),
      )
      const ctx = createExecutionContext()
      try {
        const body = JSON.parse(await getPackumentBody(env, 'vite-plus', ctx))
        expect(Object.keys(body.versions)).toHaveLength(176)
        expect(get).toHaveBeenCalledTimes(2 + missing)
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(put).toHaveBeenCalledTimes(3)
        const entry = log.mock.calls.find(([message]) =>
          String(message).includes('"event":"packument"'),
        )
        expect(JSON.parse(String(entry?.[0]))).toMatchObject({
          refs: 176,
          fallbackReads: missing,
          status: 200,
        })
      } finally {
        write.resolve()
        await waitOnExecutionContext(ctx)
      }
    },
  )

  it('reports a stalled R2 read before Void cuts off the response and stops late work', async () => {
    vi.useFakeTimers()
    const read = deferred<null>()
    vi.spyOn(env.STORAGE, 'get').mockReturnValue(read.promise)
    const get = vi.spyOn(kv, 'get')
    const put = vi.spyOn(env.KV, 'put')
    const ctx = createExecutionContext()
    const result = getPackumentBody(env, 'vite-plus', ctx).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(PACKUMENT_TIMEOUT_MS)
    expect(await result).toMatchObject({ status: 504 })
    const entry = warn.mock.calls.find(([message]) =>
      String(message).includes('"event":"packument"'),
    )
    expect(JSON.parse(String(entry?.[0]))).toMatchObject({
      status: 504,
      stages: [{ name: 'r2.refs', pending: true, durationMs: PACKUMENT_TIMEOUT_MS }],
    })
    read.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await waitOnExecutionContext(ctx)
  })
})
