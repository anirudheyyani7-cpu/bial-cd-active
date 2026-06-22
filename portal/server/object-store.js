/**
 * ObjectStore seam — the single owner of attachment BYTES.
 *
 * Portability is the whole point of this module. The metadata DB is Cosmos for
 * MongoDB now and moves to PostgreSQL later; bytes must NOT live in the metadata
 * DB (no GridFS, no inline base64) so that migration touches the repos but never
 * the byte layer. Bytes live in an S3-compatible object store reached only
 * through the tiny interface below:
 *
 *   put(key, buffer, contentType) -> Promise<void>
 *   get(key)                      -> Promise<Buffer>
 *   delete(key)                   -> Promise<void>
 *   exists(key)                   -> Promise<boolean>
 *
 * The concrete backend (MinIO on the BIAL network for the POC; Azure Blob's S3
 * endpoint or AWS S3 later) is one swappable module: a single S3 client pointed
 * at the configured endpoint. Callers (attachments-repo) take an ObjectStore by
 * injection and never see an SDK type, so the backend can change without touching
 * them — and tests inject an in-memory fake (see __tests__/fakeObjectStore.js).
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { BlobServiceClient } from '@azure/storage-blob'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required object-store env var: ${name}. Copy .env.example to .env.`)
  }
  return value
}

/**
 * Build an ObjectStore backed by an S3-compatible endpoint. `forcePathStyle` is
 * on by default because MinIO (and most non-AWS S3 endpoints) require path-style
 * bucket addressing (`endpoint/bucket/key`) rather than the virtual-host style
 * AWS prefers. Region is optional — MinIO ignores it, but the SDK requires SOME
 * value, so it defaults to `us-east-1`.
 */
export function createS3ObjectStore({
  endpoint,
  bucket,
  accessKeyId,
  secretAccessKey,
  region = 'us-east-1',
  forcePathStyle = true,
} = {}) {
  if (!bucket) throw new Error('createS3ObjectStore: bucket is required')
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  })

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      )
    },

    /** Return the object's full bytes as a Buffer (attachments are ≤4 MB). */
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      // The v3 SDK mixes streaming helpers onto Body; transformToByteArray reads
      // the whole object into memory — fine at the 4 MB attachment cap.
      return Buffer.from(await res.Body.transformToByteArray())
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return true
      } catch (err) {
        // A genuine miss is a 404 / NotFound / NoSuchKey; anything else (auth,
        // network) is a real error and must propagate, not read as "absent".
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
          return false
        }
        throw err
      }
    },
  }
}

/**
 * Build an ObjectStore backed by **Azure Blob Storage** (native API via
 * `@azure/storage-blob`). Azure Blob is NOT S3-compatible, so it needs its own
 * backend rather than the S3 client — same tiny interface, different SDK. The
 * `container` is the namespace (analogous to an S3 bucket); blob names carry the
 * `att/<username>/<id>` key verbatim (Azure allows `/` as a virtual directory).
 * Auth is a connection string (account key or SAS). Local dev points at Azurite.
 */
export function createAzureObjectStore({ connectionString, container } = {}) {
  if (!connectionString) throw new Error('createAzureObjectStore: connectionString is required')
  if (!container) throw new Error('createAzureObjectStore: container is required')
  const containerClient = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(
    container,
  )
  const blob = (key) => containerClient.getBlockBlobClient(key)

  return {
    async put(key, body, contentType) {
      await blob(key).uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } })
    },

    /** Return the blob's full bytes as a Buffer (attachments are ≤4 MB). */
    async get(key) {
      try {
        return await blob(key).downloadToBuffer()
      } catch (err) {
        // Normalize Azure's 404 (RestError code BlobNotFound) to the shape the
        // download route's isNotFound() recognizes, so a miss is a 404 not a 500.
        if (err?.statusCode === 404 || err?.code === 'BlobNotFound') {
          const e = new Error('NotFound')
          e.name = 'NotFound'
          e.$metadata = { httpStatusCode: 404 }
          throw e
        }
        throw err
      }
    },

    async delete(key) {
      await blob(key).deleteIfExists()
    },

    async exists(key) {
      return await blob(key).exists()
    },
  }
}

let objectStore = null

/**
 * Lazily build + cache the configured ObjectStore (mirrors cosmos.js's
 * getXCollection idiom). The backend is chosen by `OBJECT_STORE_PROVIDER`
 * (`s3` default, or `azure`). Fails loud when a required var is missing. The
 * bucket/container + access policy are a deploy prerequisite — this only
 * connects, never creates.
 */
export function getObjectStore() {
  if (objectStore) return objectStore
  const provider = (process.env.OBJECT_STORE_PROVIDER || 's3').toLowerCase()
  if (provider === 'azure') {
    objectStore = createAzureObjectStore({
      connectionString: requireEnv('AZURE_STORAGE_CONNECTION_STRING'),
      container: requireEnv('OBJECT_STORE_BUCKET'), // reuse the bucket var as the container name
    })
  } else if (provider === 's3') {
    objectStore = createS3ObjectStore({
      endpoint: requireEnv('OBJECT_STORE_ENDPOINT'),
      bucket: requireEnv('OBJECT_STORE_BUCKET'),
      accessKeyId: requireEnv('OBJECT_STORE_ACCESS_KEY'),
      secretAccessKey: requireEnv('OBJECT_STORE_SECRET_KEY'),
      region: process.env.OBJECT_STORE_REGION || 'us-east-1',
    })
  } else {
    // Fail loud on a typo'd provider rather than silently falling back to S3.
    throw new Error(`Unknown OBJECT_STORE_PROVIDER: "${provider}". Use "azure" or "s3".`)
  }
  return objectStore
}

/** Test hook: drop the cached store so a fresh one is built. */
export function _resetObjectStore() {
  objectStore = null
}
