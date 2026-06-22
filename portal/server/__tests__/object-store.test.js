/**
 * object-store provider switch (getObjectStore). The concrete adapters are thin
 * SDK wrappers verified by the live integration suite (scripts/qa-attachments.sh
 * against MinIO + Azurite); this pins the backend-selection logic that runs at
 * boot — picking the right backend by OBJECT_STORE_PROVIDER and failing loud on a
 * typo or a missing required var, all without touching the network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getObjectStore, _resetObjectStore } from '../object-store.js'

const KEYS = [
  'OBJECT_STORE_PROVIDER',
  'AZURE_STORAGE_CONNECTION_STRING',
  'OBJECT_STORE_BUCKET',
  'OBJECT_STORE_ENDPOINT',
  'OBJECT_STORE_ACCESS_KEY',
  'OBJECT_STORE_SECRET_KEY',
  'OBJECT_STORE_REGION',
]

describe('getObjectStore — provider switch', () => {
  let saved
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    KEYS.forEach((k) => delete process.env[k])
    _resetObjectStore()
  })
  afterEach(() => {
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])))
    _resetObjectStore()
  })

  it('throws a clear error on an unknown provider (typo fails loud, no silent S3 fallback)', () => {
    process.env.OBJECT_STORE_PROVIDER = 'azur' // typo
    expect(() => getObjectStore()).toThrow(/Unknown OBJECT_STORE_PROVIDER/)
  })

  it('provider=azure requires the connection string', () => {
    process.env.OBJECT_STORE_PROVIDER = 'azure'
    process.env.OBJECT_STORE_BUCKET = 'bial-attachments'
    expect(() => getObjectStore()).toThrow(/AZURE_STORAGE_CONNECTION_STRING/)
  })

  it('provider=azure builds an ObjectStore with the full interface when configured', () => {
    process.env.OBJECT_STORE_PROVIDER = 'azure'
    process.env.OBJECT_STORE_BUCKET = 'bial-attachments'
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=key==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;'
    const store = getObjectStore()
    expect(typeof store.put).toBe('function')
    expect(typeof store.get).toBe('function')
    expect(typeof store.delete).toBe('function')
    expect(typeof store.exists).toBe('function')
  })

  it('defaults to s3 when unset, and s3 requires its endpoint', () => {
    // no OBJECT_STORE_PROVIDER → defaults to s3 (back-compat for existing deploys)
    expect(() => getObjectStore()).toThrow(/OBJECT_STORE_ENDPOINT/)
  })
})
