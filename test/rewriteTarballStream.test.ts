import { describe, expect, it } from 'vitest'
import { createTarGzip, parseTarGzip } from 'nanotar'
import { rewriteTarballEntryStream } from '../src/tarball/rewriteTarballStream'
import { PACKAGE_JSON_NAMES } from '../src/tarball/buildPreviewTarball'

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

// Deterministic high-entropy (incompressible) bytes, like a native binary.
function pseudoBinary(size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = 0x12345678
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = (x >>> 24) & 0xff
  }
  return out
}

const rewriteVersion = (data: Uint8Array): Uint8Array => {
  const pkg = JSON.parse(new TextDecoder().decode(data))
  pkg.version = '0.0.0-commit.abc1234'
  return new TextEncoder().encode(`${JSON.stringify(pkg, null, 2)}\n`)
}

describe('rewriteTarballEntryStream', () => {
  it('swaps package.json and preserves a large binary entry byte-for-byte', async () => {
    const binary = pseudoBinary(6 * 1024 * 1024) // 6 MiB, crosses many chunks
    const upstream = await createTarGzip([
      {
        name: 'package/package.json',
        data: new TextEncoder().encode(
          JSON.stringify(
            { name: '@scope/pkg-darwin-x64', version: '0.2.1', os: ['darwin'] },
            null,
            2,
          ),
        ),
      },
      { name: 'package/LICENSE', data: new TextEncoder().encode('MIT\n') },
      { name: 'package/binding.node', data: binary },
    ])

    const out = await collect(
      rewriteTarballEntryStream(
        streamOf(upstream),
        PACKAGE_JSON_NAMES,
        rewriteVersion,
      ),
    )

    const files = await parseTarGzip(out)
    const byName = new Map(files.map((f) => [f.name, f]))

    // package.json was rewritten.
    const pkg = JSON.parse(
      new TextDecoder().decode(byName.get('package/package.json')!.data!),
    )
    expect(pkg.version).toBe('0.0.0-commit.abc1234')
    expect(pkg.name).toBe('@scope/pkg-darwin-x64')
    expect(pkg.os).toEqual(['darwin'])

    // The large binary is byte-identical (never recompressed/corrupted).
    const outBin = byName.get('package/binding.node')!.data!
    expect(outBin.byteLength).toBe(binary.byteLength)
    expect(bytesEqual(outBin, binary)).toBe(true)

    // Other entries pass through untouched.
    expect(new TextDecoder().decode(byName.get('package/LICENSE')!.data!)).toBe(
      'MIT\n',
    )
  })

  it('handles package.json as the last entry and a shorter rewritten body', async () => {
    const binary = pseudoBinary(1024 * 1024)
    const upstream = await createTarGzip([
      { name: 'package/binding.node', data: binary },
      {
        name: 'package/package.json',
        data: new TextEncoder().encode(
          JSON.stringify({
            name: 'x',
            version: '0.2.1',
            description: 'a much longer original description that will shrink',
          }),
        ),
      },
    ])

    const out = await collect(
      rewriteTarballEntryStream(streamOf(upstream), PACKAGE_JSON_NAMES, (d) => {
        const pkg = JSON.parse(new TextDecoder().decode(d))
        pkg.version = '0.0.0-commit.deadbee'
        delete pkg.description
        return new TextEncoder().encode(JSON.stringify(pkg))
      }),
    )

    const files = await parseTarGzip(out)
    const byName = new Map(files.map((f) => [f.name, f]))
    const pkg = JSON.parse(
      new TextDecoder().decode(byName.get('package/package.json')!.data!),
    )
    expect(pkg.version).toBe('0.0.0-commit.deadbee')
    expect(pkg.description).toBeUndefined()
    expect(bytesEqual(byName.get('package/binding.node')!.data!, binary)).toBe(
      true,
    )
  })
})
