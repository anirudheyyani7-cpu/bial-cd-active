/**
 * ObjectStore.getDownloadUrl — the symmetric download-offload seam (U1).
 *
 * Both backends SIGN OFFLINE (pure crypto, no network): the Azure account-key SAS
 * and the S3/MinIO presigned GET are built from the configured credential without
 * a round-trip, so this pins the URL shape (read-only, TTL, content-disposition,
 * IP scope) and the fail-loud behaviour when a backend cannot sign — without infra.
 *
 * The mongodb driver is mocked so cosmos.js's lazy-singleton `getAppFilesCollection`
 * can be exercised without a live Cosmos account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('mongodb', () => {
  const collection = { __appFilesSentinel: true }
  const client = { db: () => ({ collection: () => collection }) }
  function MongoClient() {
    return { connect: () => Promise.resolve(client) }
  }
  return { MongoClient }
})

import { createAzureObjectStore, createS3ObjectStore } from '../object-store.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { getAppFilesCollection, _resetMongo } from '../cosmos.js'

// Azurite well-known dev account (valid base64 key → a real SharedKeyCredential).
const AZURITE =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;'

describe('Azure getDownloadUrl — account-key SAS', () => {
  let savedIp
  beforeEach(() => {
    savedIp = process.env.FILE_SAS_SIGNED_IP
  })
  afterEach(() => {
    savedIp === undefined ? delete process.env.FILE_SAS_SIGNED_IP : (process.env.FILE_SAS_SIGNED_IP = savedIp)
  })

  it('mints a read-only single-blob SAS with TTL, pinned disposition, content-type, and IP scope', async () => {
    process.env.FILE_SAS_SIGNED_IP = '10.20.30.40'
    const store = createAzureObjectStore({ connectionString: AZURITE, container: 'bial-attachments' })
    const url = await store.getDownloadUrl('apps/app-1/file-1', {
      expiresInSeconds: 120,
      filename: 'Report 2026.pdf',
      contentType: 'application/pdf',
    })
    const u = new URL(url)
    expect(u.searchParams.get('sp')).toBe('r') // read-only
    expect(u.searchParams.get('sig')).toBeTruthy() // signed (a signature, not the key)
    expect(u.searchParams.get('sip')).toBe('10.20.30.40') // IP-scoped to the BIAL range
    const rscd = u.searchParams.get('rscd')
    expect(rscd).toContain('attachment')
    expect(rscd).toContain('Report_2026.pdf') // sanitized: space → _ (no header injection)
    expect(u.searchParams.get('rsct')).toBe('application/pdf')
    const se = new Date(u.searchParams.get('se')).getTime()
    expect(se).toBeGreaterThan(Date.now())
    expect(se).toBeLessThanOrEqual(Date.now() + 122 * 1000) // TTL reflected in `se`
  })

  it('omits the IP scope when FILE_SAS_SIGNED_IP is unset', async () => {
    delete process.env.FILE_SAS_SIGNED_IP
    const store = createAzureObjectStore({ connectionString: AZURITE, container: 'c' })
    const url = await store.getDownloadUrl('apps/a/f', { expiresInSeconds: 60 })
    expect(new URL(url).searchParams.get('sip')).toBeNull()
  })

  it('throws when the connection string carries no account key (route maps to 501)', async () => {
    const sasConn =
      'BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=sv=2019-12-12&ss=b&srt=s&sp=r&se=2099-01-01T00:00:00Z&sig=Zm9vYmFy'
    const store = createAzureObjectStore({ connectionString: sasConn, container: 'c' })
    await expect(store.getDownloadUrl('apps/a/f')).rejects.toThrow()
  })
})

describe('S3 getDownloadUrl — presigned GET', () => {
  it('returns a presigned URL with X-Amz-Expires + response-content-disposition', async () => {
    const store = createS3ObjectStore({
      endpoint: 'http://minio.internal:9000',
      bucket: 'bial',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      region: 'us-east-1',
    })
    const url = await store.getDownloadUrl('apps/a/f', {
      expiresInSeconds: 300,
      filename: 'out.csv',
      contentType: 'text/csv',
    })
    const u = new URL(url)
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(u.searchParams.get('response-content-disposition')).toContain('out.csv')
  })
})

describe('fake getDownloadUrl', () => {
  it('returns a deterministic https stub embedding the key', async () => {
    const store = makeFakeObjectStore()
    const url = await store.getDownloadUrl('apps/app-7/file-9', { expiresInSeconds: 90, filename: 'r.pdf' })
    expect(url.startsWith('https://')).toBe(true) // satisfies the BIALData https-scheme guard
    expect(url).toContain('apps/app-7/file-9')
    expect(url).toContain('se=90')
  })
})

describe('getAppFilesCollection — lazy singleton + reset', () => {
  const KEYS = ['MONGODB_DATABASE', 'MONGODB_APP_FILES_COLLECTION', 'MONGODB_URI']
  let saved
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    _resetMongo()
  })
  afterEach(() => {
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])))
    _resetMongo()
  })

  it('throws clearly when MONGODB_APP_FILES_COLLECTION is unset', async () => {
    process.env.MONGODB_DATABASE = 'citizen_portal'
    delete process.env.MONGODB_APP_FILES_COLLECTION
    await expect(getAppFilesCollection()).rejects.toThrow(/MONGODB_APP_FILES_COLLECTION/)
  })

  it('caches the handle, and _resetMongo re-resolves it', async () => {
    process.env.MONGODB_DATABASE = 'citizen_portal'
    process.env.MONGODB_APP_FILES_COLLECTION = 'app_files'
    process.env.MONGODB_URI = 'mongodb://fake/' // mocked driver — no network
    const a = await getAppFilesCollection()
    const b = await getAppFilesCollection()
    expect(b).toBe(a) // second call returns the cached handle
    _resetMongo()
    const c = await getAppFilesCollection() // re-resolves after the cache is cleared
    expect(c).toEqual(a)
  })
})
