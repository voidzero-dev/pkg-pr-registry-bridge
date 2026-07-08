import { SELF, env } from 'cloudflare:test'
import {
  casKey,
  metaIndexKey,
  metaKey,
  tarballKey,
} from '../src/cache/r2Cache'
import { computeDigests } from '../src/tarball/digests'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTarGzip } from 'nanotar'

// Content-addressed tarball URLs: the dist.shasum lives in the URL/key, so a
// republish with different bytes gets a different URL and BOTH builds' bytes
// coexist. This lets /-/publish stay last-write-wins with no write-once and no
// revalidation, while the packument-advertised URL still always serves bytes
// that hash to the advertised integrity — the invariant these tests pin down.

const BASE = 'https://bridge.example.com'
const AUTH = { authorization: 'Bearer test-admin-token' }
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' }
const NAME = 'vite-plus'

// The worker-under-test (reached via SELF.fetch) runs in this isolate, so a
// `vi.stubGlobal('fetch', ...)` mock intercepts its outbound npm/pkg.pr.new
// calls; a 404 makes the packument synthesize a preview-only document, so these
// tests do not depend on npm.
beforeAll(() => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('https://registry.npmjs.org/')) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
})

afterAll(() => vi.unstubAllGlobals())

// A gzipped preview tarball whose `index.js` carries a marker, so two builds of
// the same (name, version) can be given DISTINCT bytes (and thus distinct
// shasums), mirroring a non-byte-reproducible rebuild.
function makeTarball(
  pkg: Record<string, any>,
  marker: string,
): Promise<Uint8Array> {
  return createTarGzip([
    { name: 'package/package.json', data: JSON.stringify(pkg) },
    { name: 'package/index.js', data: `export const build = ${JSON.stringify(marker)}\n` },
  ])
}

/** Upload bytes to the content-addressed path; returns their digests. */
async function upload(
  name: string,
  version: string,
  bytes: Uint8Array,
): Promise<{ shasum: string; integrity: string }> {
  const digests = await computeDigests(bytes)
  const up = await SELF.fetch(`${BASE}/-/tarball/${name}/${version}/${digests.shasum}.tgz`, {
    method: 'PUT',
    headers: AUTH,
    body: bytes,
  })
  expect(up.status).toBe(201)
  return digests
}

/** Publish a package's meta and register the ref (the CI publish shape). */
async function publishRegister(
  name: string,
  version: string,
  ref: string,
  packageJson: Record<string, any>,
  digests: { shasum: string; integrity: string },
): Promise<void> {
  const pub = await SELF.fetch(`${BASE}/-/publish`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({
      ref,
      packages: [{ name, version, packageJson, integrity: digests.integrity, shasum: digests.shasum }],
    }),
  })
  expect(pub.status).toBe(201)
  const reg = await SELF.fetch(`${BASE}/-/register`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ ref }),
  })
  expect(reg.status).toBe(201)
}

/** Upload bytes content-addressed, then publish + register (a full CI publish). */
async function publishFull(
  name: string,
  version: string,
  ref: string,
  packageJson: Record<string, any>,
  bytes: Uint8Array,
): Promise<{ shasum: string; integrity: string }> {
  const digests = await upload(name, version, bytes)
  await publishRegister(name, version, ref, packageJson, digests)
  return digests
}

/** Read the injected version's dist from the packument. */
async function distFor(version: string): Promise<Record<string, any>> {
  const res = await SELF.fetch(`${BASE}/${NAME}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, any>
  return body.versions[version].dist
}

/** Drop every artifact a case created, so nothing leaks across cases. */
async function cleanup(version: string, shasums: string[]): Promise<void> {
  await env.STORAGE.delete(metaKey(NAME, version))
  await env.STORAGE.delete(metaIndexKey(NAME))
  await env.STORAGE.delete(tarballKey(NAME, version))
  for (const shasum of shasums) await env.STORAGE.delete(casKey(NAME, version, shasum))
}

describe('content-addressed republish integrity', () => {
  it('republish with different bytes: both content URLs serve their own bytes; the packument advertises the last write', async () => {
    const sha = 'ca50001'
    const ref = `commit.${sha}`
    const version = `0.0.0-commit.${sha}`
    const pkg = { name: NAME, version }

    const bytesA = await makeTarball(pkg, 'A')
    const bytesB = await makeTarball(pkg, 'B')
    const A = await computeDigests(bytesA)
    const B = await computeDigests(bytesB)
    // A non-byte-reproducible rebuild yields distinct content ids.
    expect(A.shasum).not.toBe(B.shasum)

    // Build A, then republish the SAME version with build B's bytes.
    await publishFull(NAME, version, ref, pkg, bytesA)
    await publishFull(NAME, version, ref, pkg, bytesB)

    // Both content URLs coexist and each serves its OWN bytes (the losing run's
    // bytes are not overwritten).
    const resA = await SELF.fetch(`${BASE}/tarballs/${NAME}/${version}/${A.shasum}.tgz`)
    expect(resA.status).toBe(200)
    expect((await computeDigests(new Uint8Array(await resA.arrayBuffer()))).shasum).toBe(A.shasum)

    const resB = await SELF.fetch(`${BASE}/tarballs/${NAME}/${version}/${B.shasum}.tgz`)
    expect(resB.status).toBe(200)
    expect((await computeDigests(new Uint8Array(await resB.arrayBuffer()))).shasum).toBe(B.shasum)

    // The packument advertises B (last write wins), and B's content URL serves
    // bytes that hash to the advertised integrity.
    const dist = await distFor(version)
    expect(dist.tarball).toBe(`${BASE}/tarballs/${NAME}/${version}/${B.shasum}.tgz`)
    expect(dist.integrity).toBe(B.integrity)
    const served = new Uint8Array(await (await SELF.fetch(dist.tarball)).arrayBuffer())
    expect((await computeDigests(served)).integrity).toBe(dist.integrity)

    await cleanup(version, [A.shasum, B.shasum])
  })

  it('the packument-advertised content URL always hashes to the advertised integrity', async () => {
    const sha = 'ca50002'
    const ref = `commit.${sha}`
    const version = `0.0.0-commit.${sha}`
    const pkg = { name: NAME, version }

    const { shasum } = await publishFull(NAME, version, ref, pkg, await makeTarball(pkg, 'only'))

    const dist = await distFor(version)
    const served = new Uint8Array(await (await SELF.fetch(dist.tarball)).arrayBuffer())
    expect((await computeDigests(served)).integrity).toBe(dist.integrity)

    await cleanup(version, [shasum])
  })

  it('migration fallback: an old version-addressed publish serves the current build revalidatable, and a superseded shasum 404s', async () => {
    const sha = 'ca50003'
    const ref = `commit.${sha}`
    const version = `0.0.0-commit.${sha}`
    const pkg = { name: NAME, version }

    const bytes = await makeTarball(pkg, 'legacy')
    const { shasum, integrity } = await computeDigests(bytes)
    // Simulate an OLD (version-addressed) publish action mid-migration: it stored
    // the bytes at the legacy version key and published this same shasum, but the
    // CAS object never got written (the new content path is what writes it).
    await env.STORAGE.put(tarballKey(NAME, version), bytes, {
      httpMetadata: { contentType: 'application/gzip' },
    })
    await publishRegister(NAME, version, ref, pkg, { shasum, integrity })

    // The packument advertises the content URL derived from that shasum.
    const dist = await distFor(version)
    expect(dist.tarball).toBe(`${BASE}/tarballs/${NAME}/${version}/${shasum}.tgz`)

    // (a) With no CAS object, the fallback serves the legacy bytes for the CURRENT
    // build's content URL: 200, bytes hash to the advertised integrity, but NOT
    // immutable (the legacy key is mutable, so the response must be revalidatable).
    const res = await SELF.fetch(dist.tarball)
    expect(res.status).toBe(200)
    const served = new Uint8Array(await res.arrayBuffer())
    expect((await computeDigests(served)).integrity).toBe(integrity)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(res.headers.get('cache-control')).not.toContain('immutable')

    // (b) A content URL for a DIFFERENT (not-current) 40-hex shasum on this version
    // 404s: the fallback is gated on meta.shasum === requested shasum, so it never
    // serves the legacy bytes under some other build's content id.
    const otherShasum = 'b'.repeat(40)
    expect(otherShasum).not.toBe(shasum)
    const other = await SELF.fetch(`${BASE}/tarballs/${NAME}/${version}/${otherShasum}.tgz`)
    expect(other.status).toBe(404)

    await cleanup(version, [shasum])
  })

  it('compat redirect: the legacy version URL 302-redirects to the current content URL', async () => {
    const sha = 'ca50004'
    const ref = `commit.${sha}`
    const version = `0.0.0-commit.${sha}`
    const pkg = { name: NAME, version }

    const { shasum } = await publishFull(NAME, version, ref, pkg, await makeTarball(pkg, 'compat'))

    const res = await SELF.fetch(`${BASE}/tarballs/${NAME}/${version}.tgz`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${BASE}/tarballs/${NAME}/${version}/${shasum}.tgz`,
    )
    // The version->build mapping is mutable, so the redirect is not cached.
    expect(res.headers.get('cache-control')).toBe('no-store')

    await cleanup(version, [shasum])
  })
})
