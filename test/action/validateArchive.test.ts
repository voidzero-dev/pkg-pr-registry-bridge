/**
 * SR-6 canonical archive policy (RFC 0002).
 *
 * Each case builds a hostile archive and asserts it is refused. The
 * duplicate-manifest case is the one worth reading: it is what a validator
 * built on "find the first package/package.json" passes while pnpm extracts
 * the last, so the validator would approve metadata no consumer ever sees.
 */
import { describe, expect, it } from 'vitest'
import { createTar, createTarGzip, type TarFileInput } from 'nanotar'
import {
  assertBoundedTarRecords,
  assertCanonicalEntries,
  gunzipBounded,
  normalizeEntryName,
  validateArchive,
  DEFAULT_ARCHIVE_POLICY,
} from '../../src/tarball/validateArchive'

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'vite-plus', version: '1.0.0', ...over })

function goodEntries(): TarFileInput[] {
  return [
    { name: 'package/package.json', data: manifest() },
    { name: 'package/index.js', data: 'export const x = 1\n' },
  ]
}

/** Gzip arbitrary bytes, for the bomb case. */
async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Rewrite an entry's name directly in the tar header.
 *
 * nanotar's WRITER normalizes names (`package/../../etc/passwd` is emitted as
 * `etc/passwd`, and a leading slash is stripped), so a fixture built with it
 * can never carry a real traversal. An attacker does not use nanotar, so patch
 * the 100-byte name field in place and recompute the header checksum, which is
 * what a hand-rolled malicious archive looks like.
 */
function renameTarEntry(raw: Uint8Array, from: string, to: string): Uint8Array {
  const out = new Uint8Array(raw)
  const needle = new TextEncoder().encode(from)

  let headerStart = -1
  for (let block = 0; block * 512 < out.length; block++) {
    const offset = block * 512
    let match = true
    for (let i = 0; i < needle.length; i++) {
      if (out[offset + i] !== needle[i]) {
        match = false
        break
      }
    }
    // The name field must be NUL-terminated right after the needle.
    if (match && out[offset + needle.length] === 0) {
      headerStart = offset
      break
    }
  }
  if (headerStart < 0) throw new Error(`fixture entry not found: ${from}`)

  const encoded = new TextEncoder().encode(to)
  if (encoded.length > 100) throw new Error('fixture name exceeds the tar name field')
  out.fill(0, headerStart, headerStart + 100)
  out.set(encoded, headerStart)

  // Checksum is the unsigned sum of the header bytes with the checksum field
  // read as spaces, stored as 6 octal digits + NUL + space at offset 148.
  out.fill(0x20, headerStart + 148, headerStart + 156)
  let sum = 0
  for (let i = headerStart; i < headerStart + 512; i++) sum += out[i]
  const octal = sum.toString(8).padStart(6, '0')
  out.set(new TextEncoder().encode(octal), headerStart + 148)
  out[headerStart + 154] = 0
  out[headerStart + 155] = 0x20
  return out
}

/** Build a gzipped archive whose entry name bypasses nanotar's normalization. */
async function gzWithRawName(
  entries: TarFileInput[],
  from: string,
  to: string,
): Promise<Uint8Array> {
  return gzipBytes(renameTarEntry(createTar(entries), from, to))
}

/** Build one raw tar record header with a given type flag and payload size. */
function record(name: string, typeFlag: string, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  const enc = new TextEncoder()
  header.set(enc.encode(name).slice(0, 100), 0)
  header.set(enc.encode('0000644\0'), 100)
  header.set(enc.encode(payload.length.toString(8).padStart(11, '0') + '\0'), 124)
  header.set(enc.encode('00000000000\0'), 136)
  header[156] = typeFlag.charCodeAt(0)
  header.set(enc.encode('ustar\0'), 257)
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const b of header) sum += b
  header.set(enc.encode(sum.toString(8).padStart(6, '0')), 148)
  header[154] = 0
  header[155] = 0x20
  const padded = new Uint8Array(Math.ceil(payload.length / 512) * 512)
  padded.set(payload)
  const out = new Uint8Array(header.length + padded.length)
  out.set(header)
  out.set(padded, header.length)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total + 1024) // end-of-archive marker
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/**
 * A PAX record is `<total-length> key=value\n`, where the length counts its
 * own digits. It renames the record that FOLLOWS it, so these fixtures set
 * the path the next entry already has, keeping the archive otherwise normal.
 */
function paxRecord(key: string, value: string): Uint8Array {
  const suffix = ` ${key}=${value}\n`
  let digits = 1
  while (String(digits + suffix.length).length + suffix.length !== digits + suffix.length) {
    digits++
  }
  return new TextEncoder().encode(`${digits + suffix.length}${suffix}`)
}


describe('validateArchive: accepts real package tarballs', () => {
  it('accepts a normal npm layout', async () => {
    const files = await validateArchive(await createTarGzip(goodEntries()))
    expect(files.some((f) => f.name === 'package/package.json')).toBe(true)
  })

  it('accepts a ./-prefixed layout', async () => {
    await expect(
      validateArchive(
        await createTarGzip([
          { name: './package/package.json', data: manifest() },
          { name: './package/index.js', data: 'x\n' },
        ]),
      ),
    ).resolves.toBeDefined()
  })

  it('accepts directory entries', async () => {
    await expect(
      validateArchive(
        await createTarGzip([
          { name: 'package', data: '', attrs: { mode: '755' } },
          ...goodEntries(),
        ]),
      ),
    ).resolves.toBeDefined()
  })
})

describe('validateArchive: parser differentials', () => {
  it('rejects two package/package.json entries', async () => {
    // A validator using find() would read the FIRST and approve `vite-plus`,
    // while an extractor taking the last writes the second manifest to disk.
    const archive = await createTarGzip([
      { name: 'package/package.json', data: manifest() },
      { name: 'package/index.js', data: 'x\n' },
      { name: 'package/package.json', data: manifest({ name: 'evil', version: '9.9.9' }) },
    ])
    await expect(validateArchive(archive)).rejects.toThrow(
      /more than one package\/package\.json|Duplicate entry/,
    )
  })

  it('rejects a duplicate manifest disguised by a ./ prefix', async () => {
    const archive = await createTarGzip([
      { name: 'package/package.json', data: manifest() },
      { name: './package/package.json', data: manifest({ name: 'evil' }) },
    ])
    await expect(validateArchive(archive)).rejects.toThrow(
      /Duplicate entry|more than one/,
    )
  })

  it('rejects a duplicate manifest disguised by a doubled slash', async () => {
    const archive = await createTarGzip([
      { name: 'package/package.json', data: manifest() },
      { name: 'package//package.json', data: manifest({ name: 'evil' }) },
    ])
    await expect(validateArchive(archive)).rejects.toThrow(/Duplicate entry|more than one/)
  })

  it('rejects duplicate ordinary paths', async () => {
    const archive = await createTarGzip([
      ...goodEntries(),
      { name: 'package/index.js', data: 'export const x = 2\n' },
    ])
    await expect(validateArchive(archive)).rejects.toThrow(/Duplicate entry/)
  })

  it('normalizes the forms an extractor would treat as one path', () => {
    for (const name of ['package/a.js', './package/a.js', 'package//a.js', 'package/a.js/']) {
      expect(normalizeEntryName(name)).toBe('package/a.js')
    }
  })
})

describe('validateArchive: unsafe paths and entry types', () => {
  /**
   * nanotar's parser runs `_sanitizePath` on every entry name: it resolves
   * `..` by popping, strips a leading `/` or `C:/`, and drops `.` and empty
   * segments. So an escaping name never reaches our checks with its original
   * shape, and these archives are refused for landing outside `package/`
   * instead. That is the correct outcome by a different route, so assert the
   * outcome here and cover our own checks directly below, where they are
   * reachable.
   */
  const escaping = [
    ['traversal from the root', '../../etc/passwd'],
    ['traversal mid-path', 'package/../../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['windows drive letter', 'C:/windows/system32/x.dll'],
  ] as const

  for (const [label, name] of escaping) {
    it(`refuses an archive containing a ${label}`, async () => {
      const archive = await gzWithRawName(
        [...goodEntries(), { name: 'package/PLACEHOLDER', data: 'x' }],
        'package/PLACEHOLDER',
        name,
      )
      await expect(validateArchive(archive)).rejects.toThrow(
        /traversal|absolute|drive-letter|outside the package\/ root/,
      )
    })
  }

  // Reachable only by calling the entry policy directly, which is exactly the
  // point: if nanotar ever stops sanitizing, these are what still refuse.
  const file = { name: 'package/package.json', type: 'file', size: 2, data: new Uint8Array([123, 125]) }
  const withEntry = (name: string) =>
    [file, { name, type: 'file', size: 1, data: new Uint8Array([120]) }] as never

  it('refuses traversal on its own', () => {
    expect(() => assertCanonicalEntries(withEntry('../../etc/passwd'))).toThrow(/traversal/i)
  })

  it('refuses an absolute path on its own', () => {
    expect(() => assertCanonicalEntries(withEntry('/etc/passwd'))).toThrow(/absolute/i)
  })

  it('refuses a drive-letter path on its own', () => {
    expect(() => assertCanonicalEntries(withEntry('C:/windows/x.dll'))).toThrow(
      /drive-letter/i,
    )
  })

  it('refuses a backslash traversal on its own', () => {
    expect(() => assertCanonicalEntries(withEntry('package\\..\\..\\etc\\passwd'))).toThrow(
      /traversal/i,
    )
  })

  it('rejects entries outside the package root', async () => {
    const archive = await createTarGzip([...goodEntries(), { name: 'other/thing.js', data: 'x' }])
    await expect(validateArchive(archive)).rejects.toThrow(/outside the package\/ root/)
  })

  it('rejects a missing manifest', async () => {
    const archive = await createTarGzip([{ name: 'package/index.js', data: 'x' }])
    await expect(validateArchive(archive)).rejects.toThrow(/missing package\/package\.json/)
  })

  it('rejects an empty archive', async () => {
    await expect(validateArchive(await createTarGzip([]))).rejects.toThrow(/no entries/)
  })

  // nanotar writes the type byte from the header; build the entry list directly
  // so a symlink/hardlink/device type can be asserted on.
  for (const [label, typeFlag] of [
    ['symlink', '2'],
    ['hardlink', '1'],
    ['character device', '3'],
    ['fifo', '6'],
  ] as const) {
    it(`rejects a ${label} entry`, () => {
      const files = [
        { name: 'package/package.json', type: 'file', size: 2, data: new Uint8Array([123, 125]) },
        { name: 'package/link', type: undefined as unknown as string, size: 0 },
      ]
      // Drive the entry-level policy directly: the type is what is under test,
      // and nanotar's writer does not emit these types.
      const typed = files.map((f, i) =>
        i === 1
          ? { ...f, type: { '1': 'hardLink', '2': 'symbolicLink', '3': 'characterDevice', '6': 'fifo' }[typeFlag] }
          : f,
      )
      expect(() => assertCanonicalEntries(typed as never)).toThrow(
        /Unsupported tar entry type/,
      )
    })
  }

  it('rejects an entry whose type nanotar could not classify', () => {
    expect(() =>
      assertCanonicalEntries([
        { name: 'package/package.json', type: 'file', size: 2, data: new Uint8Array([123, 125]) },
        { name: 'package/weird', type: undefined, size: 0 },
      ] as never),
    ).toThrow(/Unsupported tar entry type unknown/)
  })
})

describe('validateArchive: size and count bounds', () => {
  it('rejects too many entries', async () => {
    const entries = [
      { name: 'package/package.json', data: manifest() },
      ...Array.from({ length: 40 }, (_, i) => ({
        name: `package/f${i}.js`,
        data: 'x',
      })),
    ]
    // The raw record scan runs first and owns this rejection for a real
    // archive, because it also counts the metadata records parseTar hides.
    await expect(
      validateArchive(await createTarGzip(entries), { ...DEFAULT_ARCHIVE_POLICY, maxEntries: 10 }),
    ).rejects.toThrow(/over 10 records/)
  })

  it('still bounds entry count at the entry level', () => {
    // Reachable when the entry policy is applied on its own; keeps the second
    // layer honest rather than relying on the raw scan alone.
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `package/f${i}.js`,
      type: 'file',
      size: 1,
      data: new Uint8Array([120]),
    }))
    expect(() =>
      assertCanonicalEntries(files as never, { ...DEFAULT_ARCHIVE_POLICY, maxEntries: 10 }),
    ).toThrow(/entries, over the 10 limit/)
  })

  it('rejects an oversized single file', async () => {
    const archive = await createTarGzip([
      { name: 'package/package.json', data: manifest() },
      { name: 'package/big.bin', data: 'x'.repeat(5000) },
    ])
    await expect(
      validateArchive(archive, { ...DEFAULT_ARCHIVE_POLICY, maxFileBytes: 1000 }),
    ).rejects.toThrow(/record is \d+ bytes, over the 1000 byte limit/)
  })

  it('refuses a gzip bomb while inflating, not after', async () => {
    // 8MB of zeros compresses to a few KB. With a 64KB ceiling the inflate must
    // abort rather than materialize the whole thing.
    const bomb = await gzipBytes(new Uint8Array(8 * 1024 * 1024))
    expect(bomb.byteLength).toBeLessThan(64 * 1024)
    await expect(gunzipBounded(bomb, 64 * 1024)).rejects.toThrow(/inflates past/)
  })

  it('rejects non-gzip input', async () => {
    await expect(validateArchive(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      /not valid gzip/,
    )
  })

  it('rejects gzip that is not a tar archive', async () => {
    const notTar = await gzipBytes(new TextEncoder().encode('hello world'))
    await expect(validateArchive(notTar)).rejects.toThrow(
      /no entries|not a readable tar archive/,
    )
  })
})

/**
 * `parseTar` handles PAX (`x`, `g`) and GNU long-name (`L`, `K`, `N`) records
 * with `continue`: it decodes their payload and drops them from the returned
 * `files`. Everything checked after it therefore cannot see them, so the raw
 * record scan has to run first. Real npm tarballs do contain these records
 * (a path over 100 bytes needs one), so they are bounded rather than rejected.
 */
describe('validateArchive: metadata records parseTar hides', () => {
  it('accepts a bounded PAX record, as real long-path tarballs carry', async () => {
    const raw = concat(
      record('PaxHeader', 'x', paxRecord('path', 'package/package.json')),
      createTar(goodEntries()),
    )
    await expect(validateArchive(await gzipBytes(raw))).resolves.toBeDefined()
  })

  it('rejects an oversized PAX record that parseTar would decode', async () => {
    // 1MB payload: far past any real path, and invisible to the entry checks
    // because parseTar never returns this record.
    const huge = new Uint8Array(1024 * 1024).fill(0x41)
    const raw = concat(record('PaxHeader', 'x', huge), createTar(goodEntries()))
    await expect(validateArchive(await gzipBytes(raw))).rejects.toThrow(
      /metadata record is \d+ bytes/,
    )
  })

  it('rejects an oversized GNU long-name record', async () => {
    const huge = new Uint8Array(1024 * 1024).fill(0x42)
    const raw = concat(record('././@LongLink', 'L', huge), createTar(goodEntries()))
    await expect(validateArchive(await gzipBytes(raw))).rejects.toThrow(
      /metadata record is \d+ bytes/,
    )
  })

  it('counts metadata records toward the entry cap', async () => {
    const pax = new TextEncoder().encode('20 path=package/x\n')
    const raw = concat(
      ...Array.from({ length: 20 }, () => record('PaxHeader', 'x', pax)),
      createTar(goodEntries()),
    )
    await expect(
      validateArchive(await gzipBytes(raw), { ...DEFAULT_ARCHIVE_POLICY, maxEntries: 5 }),
    ).rejects.toThrow(/over 5 records/)
  })

  it('reads a space-padded size the same way nanotar does', () => {
    // The scanner and the parser must agree on where a record ends. An earlier
    // version stopped at the first space, so ` 2000000000\0` read as 0 here and
    // as 256MiB in nanotar; the scan then stepped into the payload, saw a zero
    // byte, and called it end-of-archive, leaving the rest unbounded.
    const raw = record('PaxHeader', 'x', new Uint8Array(0))
    raw.fill(0, 124, 136)
    new TextEncoder().encodeInto(' 2000000000 ', raw.subarray(124, 136))
    expect(() => assertBoundedTarRecords(raw)).toThrow(/metadata record is 268435456 bytes/)
  })

  it('accepts the zero-padded size form real tar writers emit', () => {
    const raw = concat(
      record('PaxHeader', 'x', paxRecord('path', 'package/package.json')),
      createTar(goodEntries()),
    )
    expect(() => assertBoundedTarRecords(raw)).not.toThrow()
  })

  it('rejects base-256 size fields outright', () => {
    const raw = record('package/big', '0', new Uint8Array(0))
    raw[124] = 0x80 // high bit marks the base-256 form
    expect(() => assertBoundedTarRecords(raw)).toThrow(/base-256/)
  })

  it('rejects a non-octal size field', () => {
    const raw = record('package/x', '0', new Uint8Array(0))
    raw.set(new TextEncoder().encode('99zz'), 124)
    expect(() => assertBoundedTarRecords(raw)).toThrow(/malformed size field/)
  })
})

describe('validateArchive: names the canonical writer cannot represent', () => {
  // nanotar writes the name into the 100-byte ustar field and emits no prefix
  // or long-name record, so a longer path is silently TRUNCATED on rebuild and
  // two paths sharing their first 100 bytes collapse into one entry, defeating
  // the duplicate rule. Refuse rather than publish a mangled archive.
  it('rejects an entry name over the ustar name field', async () => {
    // A >100-byte name cannot be written into the ustar field, so it only ever
    // reaches the parser through a PAX record. That is also exactly how a real
    // long-path npm tarball carries one.
    const long = `package/${'a'.repeat(100)}/index.js`
    expect(long.length).toBeGreaterThan(100)
    // The PAX record renames the entry that FOLLOWS it, and createTar appends
    // an end-of-archive marker, so there is exactly one createTar call and the
    // renamed entry is its first.
    const archive = await gzipBytes(
      concat(
        record('PaxHeader', 'x', paxRecord('path', long)),
        createTar([
          { name: 'package/placeholder.js', data: 'x' },
          { name: 'package/package.json', data: manifest() },
        ]),
      ),
    )
    await expect(validateArchive(archive)).rejects.toThrow(/exceeds 100 bytes/)
  })

  it('accepts a name exactly at the limit', async () => {
    const exact = `package/${'a'.repeat(92)}`
    expect(exact.length).toBe(100)
    await expect(
      validateArchive(
        await createTarGzip([
          { name: 'package/package.json', data: manifest() },
          { name: exact, data: 'x' },
        ]),
      ),
    ).resolves.toBeDefined()
  })
})

describe('validateArchive: raw tar helper', () => {
  it('inflates a normal archive fully', async () => {
    const raw = createTar(goodEntries())
    const inflated = await gunzipBounded(await gzipBytes(raw), DEFAULT_ARCHIVE_POLICY.maxTotalBytes)
    expect(inflated.byteLength).toBe(raw.byteLength)
  })
})
