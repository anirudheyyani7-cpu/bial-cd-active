/**
 * Cosmos DB for MongoDB (RU) connection seam.
 *
 * The interim-auth POC shares an existing Cosmos *for MongoDB* account, so we
 * speak the MongoDB wire protocol via the official driver — NOT the NoSQL/Core
 * SDK. This is the ONLY module that talks to the Mongo driver; `users-repo.js`
 * wraps the returned collection and tests inject a fake collection.
 *
 * Lazy singleton MongoClient + a handle to the pre-created `users` collection
 * (document key `_id` = username → single-document point reads on login and
 * refresh, with username uniqueness enforced by Mongo's `_id` index for free).
 * The database + collection are provisioned out-of-band in Data Explorer; this
 * module only connects and hands back the collection handle.
 */
import { MongoClient } from 'mongodb'

let clientPromise = null
let usersCollection = null
let usageCollection = null
let feedbackCollection = null
let conversationsCollection = null
let messagesCollection = null
let attachmentUsageCollection = null

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required Mongo env var: ${name}. Copy .env.example to .env.`)
  }
  return value
}

/**
 * Lazily construct + connect the singleton MongoClient. Connecting eagerly (vs
 * the driver's lazy connect) surfaces a bad URI / unreachable account at boot
 * instead of on the first login. Fails loud when MONGODB_URI is missing.
 */
export async function getMongoClient() {
  if (!clientPromise) {
    const uri = requireEnv('MONGODB_URI')
    const c = new MongoClient(uri, {
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 20_000,
    })
    // Cache the in-flight connect PROMISE (not just the resolved client) so two
    // concurrent first-callers share one client instead of racing to build two
    // (the loser would leak a pool). Reset on failure so a transient connect
    // error can be retried rather than caching a rejected promise.
    clientPromise = c.connect().catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

/**
 * Resolve the pre-created `users` collection (cached after first call). The
 * database + collection are created out-of-band in Data Explorer, so this only
 * connects and returns the handle — it never creates anything.
 */
export async function getUsersCollection() {
  if (usersCollection) return usersCollection
  const databaseId = requireEnv('MONGODB_DATABASE')
  const collectionId = requireEnv('MONGODB_USERS_COLLECTION')
  const db = (await getMongoClient()).db(databaseId)
  usersCollection = db.collection(collectionId)
  return usersCollection
}

/**
 * Resolve the pre-created `daily_token_usage` collection (cached after first
 * call). Like the users collection, it is provisioned out-of-band in Data
 * Explorer — this only connects and returns the handle, never creates anything.
 * Documents are keyed by `_id` = `${username}:${IST-date}` for single-document
 * point reads on the per-request usage gate.
 */
export async function getUsageCollection() {
  if (usageCollection) return usageCollection
  const databaseId = requireEnv('MONGODB_DATABASE')
  const collectionId = requireEnv('MONGODB_USAGE_COLLECTION')
  const db = (await getMongoClient()).db(databaseId)
  usageCollection = db.collection(collectionId)
  return usageCollection
}

/**
 * Resolve the pre-created `feedback` collection (cached after first call). Like
 * the users/usage collections, it is provisioned out-of-band in Data Explorer —
 * this only connects and returns the handle, never creates anything. Feedback
 * rows are append-only, keyed by a generated random `_id` (no natural key).
 */
export async function getFeedbackCollection() {
  if (feedbackCollection) return feedbackCollection
  const databaseId = requireEnv('MONGODB_DATABASE')
  const collectionId = requireEnv('MONGODB_FEEDBACK_COLLECTION')
  const db = (await getMongoClient()).db(databaseId)
  feedbackCollection = db.collection(collectionId)
  return feedbackCollection
}

/**
 * Resolve the pre-created `conversations` collection (cached after first call).
 * Holds one lightweight HEADER document per conversation (chats + builder
 * sessions) keyed by a client-minted `_id` (uuid); the per-message bodies live in
 * the `messages` collection. Like the others, provisioned out-of-band — this only
 * connects and returns the handle. Maps 1:1 to a Postgres `conversations` table.
 */
export async function getConversationsCollection() {
  if (conversationsCollection) return conversationsCollection
  const databaseId = requireEnv('MONGODB_DATABASE')
  const collectionId = requireEnv('MONGODB_CONVERSATIONS_COLLECTION')
  const db = (await getMongoClient()).db(databaseId)
  conversationsCollection = db.collection(collectionId)
  return conversationsCollection
}

/**
 * Resolve the pre-created `messages` collection (cached after first call). One
 * document per message (never an unbounded array on a growing document), keyed by
 * a client-minted `_id` (uuid), carrying a structured `parts[]` content array.
 * Provisioned out-of-band; this only connects. Maps to a Postgres `messages`
 * table with a `parts JSONB` column.
 */
export async function getMessagesCollection() {
  if (messagesCollection) return messagesCollection
  const databaseId = requireEnv('MONGODB_DATABASE')
  const collectionId = requireEnv('MONGODB_MESSAGES_COLLECTION')
  const db = (await getMongoClient()).db(databaseId)
  messagesCollection = db.collection(collectionId)
  return messagesCollection
}

/**
 * Resolve the pre-created `attachment_usage` collection (cached after first
 * call). One document per user (`_id` = username) holding the O(1) running byte
 * total for the per-user attachment quota — the ONLY attachment metadata in the
 * DB; the bytes themselves live in the object store. Provisioned out-of-band;
 * this only connects. Maps to a Postgres numeric counter.
 */
export async function getAttachmentUsageCollection() {
  if (attachmentUsageCollection) return attachmentUsageCollection
  const databaseId = requireEnv('MONGODB_DATABASE')
  const collectionId = requireEnv('MONGODB_ATTACHMENT_USAGE_COLLECTION')
  const db = (await getMongoClient()).db(databaseId)
  attachmentUsageCollection = db.collection(collectionId)
  return attachmentUsageCollection
}

/** Test hook: drop cached handles so a fresh client/collection is built. */
export function _resetMongo() {
  clientPromise = null
  usersCollection = null
  usageCollection = null
  feedbackCollection = null
  conversationsCollection = null
  messagesCollection = null
  attachmentUsageCollection = null
}
