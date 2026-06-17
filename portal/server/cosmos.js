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

let client = null
let usersCollection = null

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
  if (!client) {
    const uri = requireEnv('MONGODB_URI')
    const c = new MongoClient(uri)
    await c.connect()
    client = c
  }
  return client
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

/** Test hook: drop cached handles so a fresh client/collection is built. */
export function _resetMongo() {
  client = null
  usersCollection = null
}
