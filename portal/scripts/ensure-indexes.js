/**
 * Create the Cosmos for MongoDB composite indexes our filter+sort reads require.
 *
 *   node scripts/ensure-indexes.js
 *
 * The server also runs this at boot (server.js → ensureIndexes), so a redeploy is
 * self-healing; this standalone runner exists to unblock an ALREADY-running prod
 * (the one logging `BadRequest (400) ... no corresponding composite index`)
 * without waiting for a redeploy. Idempotent — re-running only no-ops on indexes
 * that already exist. Loads .env itself (run from portal/).
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { ensureIndexes } from '../server/ensure-indexes.js'
import {
  getConversationsCollection,
  getMessagesCollection,
  getFeedbackCollection,
  getDataRecordsCollection,
  getAppFilesCollection,
} from '../server/cosmos.js'

async function main() {
  try {
    const { created, failed } = await ensureIndexes({
      conversations: await getConversationsCollection(),
      messages: await getMessagesCollection(),
      feedback: await getFeedbackCollection(),
      dataRecords: await getDataRecordsCollection(),
      appFiles: await getAppFilesCollection(),
    })
    console.log(
      `\nensure-indexes:\n  ensured: ${created} index(es)\n  failed:  ${failed}\n\n` +
        'Idempotent — re-running only touches indexes that do not yet exist.\n',
    )
    if (failed > 0) process.exitCode = 1
  } catch (err) {
    console.error('ensure-indexes failed:', err.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // MongoClient keeps a socket open; exit explicitly once done.
  main().finally(() => process.exit(process.exitCode || 0))
}
