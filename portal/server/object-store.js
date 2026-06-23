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
 *   getDownloadUrl(key, opts)     -> Promise<string>   (short-lived read URL)
 *
 * `getDownloadUrl` is the SYMMETRIC download-offload seam (per-app file storage):
 * Azure mints an account-key SAS, S3/MinIO a presigned GET. It is read-only,
 * single-blob, short-TTL, content-disposition-pinned, and (Azure) IP-scoped via
 * FILE_SAS_SIGNED_IP. A backend that cannot sign THROWS — the route maps that to a
 * 501 and the client falls back to the same-origin `/content` proxy. Note this
 * REVERSES the v1.3.0 attachment "no signed URLs" stance for the download path
 * only (the blob host stays out of the sandbox CSP — the URL is consumed by an
 * `<a download>` navigation, never a `connect-src` fetch).
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
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required object-store env var: ${name}. Copy .env.example to .env.`)
  }
  return value
}

// Default SAS / presign lifetime (seconds). Short by design — a leaked URL is
// usable only for this window. Overridden per-call by the route (FILE_SAS_TTL_SECONDS).
const DEFAULT_DOWNLOAD_TTL_SECONDS = 120

/**
 * Parse FILE_SAS_SIGNED_IP into an Azure SAS `ipRange` ({ start, end? }). Accepts
 * a single IP (`1.2.3.4`) or a range (`1.2.3.4-1.2.3.40`). Returns null when unset
 * so the caller can warn + mint without an IP scope (POC fallback). The IP scope is
 * a load-bearing containment control: it makes a leaked SAS unusable off the BIAL
 * egress range even if the storage account is publicly reachable.
 */
function parseSignedIp(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const [start, end] = raw.trim().split('-').map((s) => s.trim())
  return end ? { start, end } : { start }
}

/** Build a safe `Content-Disposition: attachment` value; never inject a raw filename. */
function attachmentDisposition(filename) {
  // The route already validates the filename against a strict regex (no quotes/CRLF/;),
  // but re-guard here so the seam can't emit a header-injecting disposition.
  const safe = typeof filename === 'string' ? filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) : ''
  return `attachment; filename="${safe || 'download'}"`
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

    /**
     * Presigned GET URL (read-only, single object, short TTL). The pinned
     * `ResponseContentDisposition`/`ResponseContentType` force the download
     * filename + MIME even cross-origin. Used only for download-to-disk; the
     * presigned host is NEVER added to the sandbox CSP.
     */
    async getDownloadUrl(key, { expiresInSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS, filename, contentType } = {}) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: attachmentDisposition(filename),
        ResponseContentType: contentType || undefined,
      })
      return await getSignedUrl(client, command, { expiresIn: expiresInSeconds })
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

    /**
     * Mint a short-lived, read-only, single-blob ACCOUNT-KEY SAS (Decision 4). The
     * shared-key credential is already inside the `fromConnectionString` client, so
     * `generateSasUrl` signs with no separately-constructed credential. Scoped as
     * tightly as the API allows: read permission only, this one blob, short TTL,
     * pinned content-disposition/content-type, and `ipRange` from FILE_SAS_SIGNED_IP
     * (the BIAL egress range) so a leaked URL is unusable off-network. THROWS when the
     * connection string carries no account key (e.g. a SAS connection string) — the
     * route maps that to a 501 and the client falls back to the `/content` proxy.
     * The account-key SAS is non-revocable until key rotation; user-delegation SAS
     * (AAD) is the deferred hardening.
     */
    async getDownloadUrl(key, { expiresInSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS, filename, contentType } = {}) {
      const now = Date.now()
      const options = {
        permissions: BlobSASPermissions.parse('r'),
        // Backdate the start a few minutes to tolerate portal↔Azure clock skew (an
        // un-backdated `st` can 403 a just-minted SAS as "not yet valid").
        startsOn: new Date(now - 5 * 60 * 1000),
        expiresOn: new Date(now + expiresInSeconds * 1000),
        contentDisposition: attachmentDisposition(filename),
      }
      if (contentType) options.contentType = contentType
      const ipRange = parseSignedIp(process.env.FILE_SAS_SIGNED_IP)
      if (ipRange) {
        options.ipRange = ipRange
      } else {
        console.warn(
          'getDownloadUrl: FILE_SAS_SIGNED_IP is unset — minting a SAS with NO IP restriction. Set it to the BIAL egress range before go-live.',
        )
      }
      return await blob(key).generateSasUrl(options)
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
