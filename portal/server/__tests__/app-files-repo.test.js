import { describe, it, expect } from 'vitest'
import {
  createAppFilesRepo,
  sanitizeFilename,
  sanitizeCollection,
  assertContentType,
  sniffMagic,
  sniffImageType,
  FileQuotaError,
} from '../app-files-repo.js'
import { createAppRegistryRepo, APP_FILE_BYTES_CAP, APP_FILE_COUNT_CAP } from '../app-registry-repo.js'
import { makeFakeAppFilesContainer } from './fakeAppFilesCosmos.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'

const A = 'app-A'
const B = 'app-B'

/** Wire an app-files repo over the REAL registry repo (its fake container) so the
 *  atomic file-quota path is exercised end-to-end. */
function setup({ files = [], registrySeed } = {}) {
  const registryDocs = registrySeed ?? [
    { _id: A, status: 'draft', fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
    { _id: B, status: 'draft', fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
  ]
  const registryContainer = makeFakeAppRegistryContainer(registryDocs)
  const registryRepo = createAppRegistryRepo(registryContainer)
  const filesContainer = makeFakeAppFilesContainer(files)
  const repo = createAppFilesRepo(filesContainer, registryRepo)
  return { repo, registryRepo, registryContainer, filesContainer }
}

const newFile = (over = {}) => ({
  appId: A,
  collection: 'default',
  filename: 'report.pdf',
  contentType: 'application/pdf',
  size: 2048,
  ...over,
})

describe('app-files-repo — insert (pending) → markReady → get/list (server owns identity)', () => {
  it('insert lands pending with a server-minted id/blobKey/status; markReady makes it listable', async () => {
    const { repo, registryContainer } = setup()
    const rec = await repo.insert(newFile({ createdBy: 'alice', createdInDraft: true }))
    expect(rec._id).toBeTypeOf('string')
    expect(rec.appId).toBe(A)
    expect(rec.blobKey).toBe(`apps/${A}/${rec._id}`) // server-minted, appId-prefixed
    expect(rec.status).toBe('pending')
    expect(rec.contentType).toBe('application/pdf')
    expect(rec.size).toBe(2048)
    expect(rec.createdBy).toBe('alice')
    expect(rec.createdInDraft).toBe(true)
    expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // quota reserved on insert (before the blob is written)
    expect(registryContainer._get(A).fileCount).toBe(1)
    expect(registryContainer._get(A).fileBytes).toBe(2048)

    // pending → invisible to app-facing reads
    expect(await repo.list(A, {})).toHaveLength(0)
    expect(await repo.get(A, rec._id)).toBeNull()
    // admin/lifecycle read sees it
    expect((await repo.get(A, rec._id, { includePending: true }))._id).toBe(rec._id)

    await repo.markReady(A, rec._id)
    const listed = await repo.list(A, {})
    expect(listed).toHaveLength(1)
    expect(listed[0]._id).toBe(rec._id)
    expect((await repo.get(A, rec._id)).filename).toBe('report.pdf')
  })

  it('server owns reserved fields — client-supplied _id/blobKey/status/appId are not honored', async () => {
    const { repo } = setup()
    const rec = await repo.insert({ ...newFile(), _id: 'spoof', blobKey: 'evil/key', status: 'ready', appId: A })
    expect(rec._id).not.toBe('spoof')
    expect(rec.blobKey).toBe(`apps/${A}/${rec._id}`)
    expect(rec.status).toBe('pending') // never the client 'ready'
  })

  it('createdBy defaults to null and createdInDraft to false', async () => {
    const { repo } = setup()
    const rec = await repo.insert(newFile())
    expect(rec.createdBy).toBeNull()
    expect(rec.createdInDraft).toBe(false)
  })

  it('list filters by collection when given', async () => {
    const { repo } = setup()
    const a = await repo.insert(newFile({ collection: 'reports', filename: 'r.pdf' }))
    const b = await repo.insert(newFile({ collection: 'sheets', filename: 's.csv', contentType: 'text/csv' }))
    await repo.markReady(A, a._id)
    await repo.markReady(A, b._id)
    expect((await repo.list(A, { collection: 'reports' })).map((f) => f._id)).toEqual([a._id])
    expect(await repo.list(A, {})).toHaveLength(2)
  })
})

describe('app-files-repo — tenant isolation (composite {_id, appId})', () => {
  it('app B never sees, reads, or deletes app A’s file', async () => {
    const { repo, filesContainer } = setup()
    const rec = await repo.insert(newFile())
    await repo.markReady(A, rec._id)
    expect(await repo.get(B, rec._id)).toBeNull()
    expect(await repo.list(B, {})).toHaveLength(0)
    expect(await repo.del(B, rec._id)).toEqual({ deleted: false })
    expect(filesContainer._store.has(rec._id)).toBe(true) // A’s file untouched
  })
})

describe('app-files-repo — quota', () => {
  it('insert past the count cap throws FileQuotaError; counters unchanged', async () => {
    const { repo, registryContainer } = setup({
      registrySeed: [{ _id: A, status: 'draft', fileCount: APP_FILE_COUNT_CAP, fileBytes: 0 }],
    })
    await expect(repo.insert(newFile({ size: 10 }))).rejects.toBeInstanceOf(FileQuotaError)
    expect(registryContainer._get(A).fileCount).toBe(APP_FILE_COUNT_CAP) // no drift
  })

  it('insert past the byte cap throws FileQuotaError', async () => {
    const { repo } = setup({
      registrySeed: [{ _id: A, status: 'draft', fileCount: 0, fileBytes: APP_FILE_BYTES_CAP }],
    })
    await expect(repo.insert(newFile({ size: 1 }))).rejects.toBeInstanceOf(FileQuotaError)
  })

  it('del returns {blobKey, size} and releases the quota (-1, -size)', async () => {
    const { repo, registryContainer } = setup()
    const rec = await repo.insert(newFile({ size: 500 }))
    await repo.markReady(A, rec._id)
    expect(registryContainer._get(A).fileBytes).toBe(500)
    const res = await repo.del(A, rec._id)
    expect(res).toMatchObject({ deleted: true, blobKey: `apps/${A}/${rec._id}`, size: 500 })
    expect(registryContainer._get(A).fileCount).toBe(0)
    expect(registryContainer._get(A).fileBytes).toBe(0)
  })

  it('del also removes a PENDING row (the upload-failure compensation path)', async () => {
    const { repo, registryContainer, filesContainer } = setup()
    const rec = await repo.insert(newFile({ size: 700 })) // stays pending
    expect(registryContainer._get(A).fileBytes).toBe(700) // reserved
    const res = await repo.del(A, rec._id)
    expect(res.deleted).toBe(true)
    expect(filesContainer._store.has(rec._id)).toBe(false)
    expect(registryContainer._get(A).fileBytes).toBe(0) // reserve released
  })
})

describe('app-files-repo — purgeByApp + recompute', () => {
  it('purgeByApp({createdInDraftOnly}) removes only draft-era files and returns their blobKeys', async () => {
    const { repo, registryContainer } = setup()
    const draft = await repo.insert(newFile({ size: 100, createdInDraft: true, filename: 'draft.pdf' }))
    const live = await repo.insert(newFile({ size: 200, createdInDraft: false, filename: 'live.pdf' }))
    await repo.markReady(A, draft._id)
    await repo.markReady(A, live._id)
    const res = await repo.purgeByApp(A, { createdInDraftOnly: true })
    expect(res.removed).toBe(1)
    expect(res.blobs).toEqual([{ fileId: draft._id, blobKey: `apps/${A}/${draft._id}` }])
    // counters decremented by the draft’s size only; the live file remains
    expect(registryContainer._get(A).fileCount).toBe(1)
    expect(registryContainer._get(A).fileBytes).toBe(200)
    expect((await repo.list(A, {})).map((f) => f._id)).toEqual([live._id])
  })

  it('full purgeByApp removes everything, returns all blobKeys, and zeroes the counters', async () => {
    const { repo, registryContainer } = setup()
    const a = await repo.insert(newFile({ size: 100 }))
    const b = await repo.insert(newFile({ size: 200 }))
    await repo.markReady(A, a._id)
    const res = await repo.purgeByApp(A, {})
    expect(res.removed).toBe(2)
    expect(res.blobs.map((x) => x.blobKey).sort()).toEqual([`apps/${A}/${a._id}`, `apps/${A}/${b._id}`].sort())
    expect(registryContainer._get(A).fileCount).toBe(0)
    expect(registryContainer._get(A).fileBytes).toBe(0)
  })

  it('a failed insert (E11000) after the reserve rolls the registry reserve back to 0', async () => {
    const { repo, registryContainer, filesContainer } = setup()
    // Make the very next insert fail AFTER the quota reserve has been taken, mirroring
    // a duplicate-key collision on the server-minted _id.
    const realInsert = filesContainer.insertOne.bind(filesContainer)
    let failed = false
    filesContainer.insertOne = async (doc) => {
      if (!failed) {
        failed = true
        const err = new Error('E11000 duplicate key error')
        err.code = 11000
        throw err
      }
      return realInsert(doc)
    }
    await expect(repo.insert(newFile({ size: 1234 }))).rejects.toThrow(/E11000/)
    // the reserve (+1, +1234) taken before the insert must be released → back to 0
    expect(registryContainer._get(A).fileCount).toBe(0)
    expect(registryContainer._get(A).fileBytes).toBe(0)
    expect([...filesContainer._store.values()]).toHaveLength(0) // nothing persisted
  })

  it('recompute rebuilds counters from ready metadata and sweeps stale pending rows', async () => {
    const { repo, registryContainer, filesContainer } = setup()
    const ready = await repo.insert(newFile({ size: 100, filename: 'a.csv', contentType: 'text/csv' }))
    await repo.markReady(A, ready._id)
    const freshPending = await repo.insert(newFile({ size: 50, filename: 'b.csv', contentType: 'text/csv' }))
    // a stale pending row (crashed upload) with an old createdAt, injected directly
    filesContainer._store.set('stale-1', {
      _id: 'stale-1',
      appId: A,
      collection: 'default',
      filename: 'old.csv',
      contentType: 'text/csv',
      size: 999,
      blobKey: `apps/${A}/stale-1`,
      status: 'pending',
      createdInDraft: false,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    })
    // drift the registry counters to a wrong value
    await registryContainer.updateOne({ _id: A }, { $set: { fileCount: 99, fileBytes: 99999 } })

    const res = await repo.recompute(A)
    expect(res.fileCount).toBe(1) // only the ready file
    expect(res.fileBytes).toBe(100)
    expect(res.sweptPending).toBe(1)
    expect(res.sweptBlobs).toEqual([{ fileId: 'stale-1', blobKey: `apps/${A}/stale-1` }])
    expect(registryContainer._get(A).fileCount).toBe(1)
    expect(registryContainer._get(A).fileBytes).toBe(100)
    expect(filesContainer._store.has('stale-1')).toBe(false) // swept
    expect(filesContainer._store.has(freshPending._id)).toBe(true) // fresh pending kept
  })
})

describe('app-files-repo — file-type validator (self-contained; SVG excluded)', () => {
  it('sanitizeFilename rejects path separators, quotes, and over-length', () => {
    expect(sanitizeFilename('report_2026.pdf').ok).toBe(true)
    expect(sanitizeFilename('../etc/passwd').ok).toBe(false)
    expect(sanitizeFilename('a/b.csv').ok).toBe(false)
    expect(sanitizeFilename('na"me.csv').ok).toBe(false)
    expect(sanitizeFilename('x'.repeat(201)).ok).toBe(false)
  })

  it('sanitizeCollection defaults to "default" and rejects bad labels', () => {
    expect(sanitizeCollection(undefined)).toEqual({ ok: true, value: 'default' })
    expect(sanitizeCollection('sheets-1').ok).toBe(true)
    expect(sanitizeCollection('bad space').ok).toBe(false)
  })

  it('assertContentType honors the allowlist and rejects image/svg+xml', () => {
    expect(assertContentType('text/csv').ok).toBe(true)
    expect(assertContentType('application/pdf').ok).toBe(true)
    expect(assertContentType('application/x-evil').ok).toBe(false)
    expect(assertContentType('image/svg+xml').ok).toBe(false) // SVG intentionally excluded
  })

  it('sniffMagic checks reliable magic and treats xls/csv/txt/json as declared-type-only', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])

    expect(sniffMagic('image/png', png).ok).toBe(true)
    expect(sniffMagic('image/png', Buffer.from('not a png')).ok).toBe(false) // declared png, wrong bytes
    expect(sniffMagic('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx).ok).toBe(true)
    expect(sniffMagic('image/webp', webp).ok).toBe(true)
    expect(sniffMagic('image/webp', Buffer.from('RIFF????junk')).ok).toBe(false) // RIFF but not WEBP

    // no reliable magic → declared-type + size only (accept any bytes)
    expect(sniffMagic('application/vnd.ms-excel', Buffer.from('anything')).ok).toBe(true) // .xls
    expect(sniffMagic('text/csv', Buffer.from('a,b,c')).ok).toBe(true)
    expect(sniffMagic('text/plain', Buffer.from('hello')).ok).toBe(true)
    expect(sniffMagic('application/json', Buffer.from('{}')).ok).toBe(true)
  })

  it('sniffImageType reverse-detects JPEG/GIF from magic and returns null for a non-image (WAVE)', () => {
    // JPEG = FF D8; GIF = 47 49 46 38 ("GIF8")
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png')
    // a true WebP (RIFF + "WEBP" form-type @8) reverse-sniffs to image/webp
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
    expect(sniffImageType(webp)).toBe('image/webp')
    // RIFF container with "WAVE" @8 (a .wav) is NOT an image → null, so it can never
    // be served inline; non-image bytes fall through to octet-stream + attachment.
    const wave = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')])
    expect(sniffImageType(wave)).toBeNull()
    // empty + plain-text bytes are not images
    expect(sniffImageType(Buffer.alloc(0))).toBeNull()
    expect(sniffImageType(Buffer.from('not an image'))).toBeNull()
  })
})
