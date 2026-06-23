/**
 * One-time backfill: populate the derived `_search` blob on `data_records` written
 * before search existed, so free-text `BIALData.query({ q })` matches legacy rows.
 *
 *   node scripts/backfill-search-docs.js [--app <appId>] [--batch <n>]
 *
 * Idempotent — only touches docs missing `_search`, so re-running is a no-op (and
 * safe to run after a partial run). Scope to one app with --app, else backfill all
 * tenants. Loads .env itself (run from portal/). New records get `_search` on write;
 * this only catches the pre-existing ones.
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { createDataRecordsRepo } from '../server/data-records-repo.js'
import { createAppRegistryRepo } from '../server/app-registry-repo.js'
import { getDataRecordsCollection, getAppRegistryCollection } from '../server/cosmos.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') args.app = argv[++i]
    else if (argv[i] === '--batch') args.batch = Number(argv[++i])
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  try {
    const registryRepo = createAppRegistryRepo(await getAppRegistryCollection())
    const repo = createDataRecordsRepo(await getDataRecordsCollection(), registryRepo)
    const batch = Number.isFinite(args.batch) && args.batch > 0 ? args.batch : 500
    const { updated } = await repo.backfillSearchDocs({ appId: args.app, batch })
    console.log(
      `\nbackfill-search-docs:\n` +
        `  scope:   ${args.app ? `app ${args.app}` : 'all apps'}\n` +
        `  updated: ${updated} record(s) given a _search blob\n\n` +
        'Idempotent — re-running only touches records still missing _search.\n',
    )
  } catch (err) {
    console.error('backfill-search-docs failed:', err.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // MongoClient keeps a socket open; exit explicitly once done.
  main().finally(() => process.exit(process.exitCode || 0))
}
