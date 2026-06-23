/**
 * READ-ONLY Cosmos probe for the dynamic record-search feature.
 *
 *   node scripts/probe-data-search.js [--app <appId>]
 *
 * Azure Cosmos DB for MongoDB (RU) 400s a filter+sort read that has no matching
 * composite index, and serves only a single-field ORDER BY (the constraint behind
 * the 1.3.1-1.3.3 chat-history hotfixes). The record-search feature is schemaless,
 * so some of its query shapes (sort by an app field, filter by an app field, the
 * free-text `_search` regex) may have NO pre-creatable index and 400 on deploy.
 * This script runs each exact query shape `data-records-repo` issues against the
 * REAL Cosmos account and reports SERVED / BLOCKED(400) / ERROR, so we fix only
 * what actually breaks instead of guessing. It is strictly read-only: only
 * find / countDocuments / distinct / listIndexes — NO writes, NO createIndex.
 *
 * Run it with the production env (the same .env the server uses). It auto-picks a
 * tenant with records (or pass --app), and discovers a real collection, a real
 * `data.<field>`+value, and a `_search` token from a sample document. Paste the
 * summary block back so we can pick the fix.
 */
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { getDataRecordsCollection } from '../server/cosmos.js'
import { escapeRegex } from '../server/data-records-repo.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') args.app = argv[++i]
  }
  return args
}

/** Classify a probe outcome. Cosmos surfaces the unservable-ORDER-BY case as a
 *  BadRequest(400) whose message names the missing composite index. */
function classifyError(err) {
  const msg = String(err && err.message ? err.message : err)
  const code = err && (err.code ?? err.codeName)
  const isOrderBy = /composite index|order.?by|corresponding composite/i.test(msg)
  const is400 = /\b400\b|BadRequest|badrequest/i.test(msg) || code === 2 || code === 16500
  if (isOrderBy) return { verdict: 'BLOCKED (no composite index for this ORDER BY)', code, msg }
  if (is400) return { verdict: 'BLOCKED (400 BadRequest)', code, msg }
  return { verdict: 'ERROR (other)', code, msg }
}

/** Pick the first scalar (string/number/bool) field of an object, with its value. */
function firstScalarField(data) {
  if (!data || typeof data !== 'object') return null
  for (const [k, v] of Object.entries(data)) {
    const t = typeof v
    if (t === 'string' || t === 'number' || t === 'boolean') return { field: k, value: v }
  }
  return null
}

async function run(label, thunk) {
  process.stdout.write(`\n• ${label}\n`)
  try {
    const out = await thunk()
    process.stdout.write(`    -> SERVED  ${out}\n`)
    return { label, ok: true }
  } catch (err) {
    const c = classifyError(err)
    process.stdout.write(`    -> ${c.verdict}\n`)
    process.stdout.write(`       code=${c.code} msg=${c.msg.slice(0, 240)}\n`)
    return { label, ok: false, verdict: c.verdict }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const coll = await getDataRecordsCollection()

  // --- choose a target tenant (one with records) ---
  let appId = args.app
  if (!appId) {
    const top = await coll
      .aggregate([{ $group: { _id: '$appId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 1 }])
      .toArray()
    appId = top[0] && top[0]._id
  }
  if (!appId) {
    console.error('No records found in data_records — nothing to probe. Seed an app first or pass --app.')
    process.exitCode = 1
    return
  }

  // --- discover a real collection, data field, and _search token from a sample ---
  const sample = await coll.findOne({ appId })
  if (!sample) {
    console.error(`No record for appId=${appId}.`)
    process.exitCode = 1
    return
  }
  const collection = sample.collection
  const scalar = firstScalarField(sample.data)
  const token =
    typeof sample._search === 'string' && sample._search.trim()
      ? sample._search.trim().split(/\s+/)[0].slice(0, 12)
      : null

  console.log('='.repeat(72))
  console.log('Cosmos record-search probe (READ-ONLY)')
  console.log('='.repeat(72))
  console.log(`appId:        ${appId}`)
  console.log(`collection:   ${collection}`)
  console.log(`data field:   ${scalar ? `${scalar.field} = ${JSON.stringify(scalar.value)}` : '(none scalar found)'}`)
  console.log(`_search token:${token ? ` "${token}"` : ' (no _search blob on sample)'}`)

  // --- existing indexes on data_records (shows whether ensure-indexes ran) ---
  try {
    const idx = await coll.listIndexes().toArray()
    console.log('\nexisting indexes on data_records:')
    for (const i of idx) console.log(`  ${i.name}: ${JSON.stringify(i.key)}`)
  } catch (err) {
    console.log(`\n(could not list indexes: ${err.message})`)
  }

  const PS = 5 // pageSize for the skip/limit probes
  const results = []

  // 1) baseline: list / search default sort — expected SERVED by {appId,createdAt}
  results.push(
    await run('find({appId}).sort({createdAt:-1}).limit(5)   [list + default search]', async () => {
      const r = await coll.find({ appId }).sort({ createdAt: -1 }).limit(5).toArray()
      return `${r.length} row(s)`
    }),
  )

  // 2) by collection — expected SERVED by {appId,collection,createdAt}
  results.push(
    await run('find({appId,collection}).sort({createdAt:-1}).limit(5)   [list by collection]', async () => {
      const r = await coll.find({ appId, collection }).sort({ createdAt: -1 }).limit(5).toArray()
      return `${r.length} row(s)`
    }),
  )

  // 3) data-field EQUALITY filter + createdAt sort — the "filter feature"
  if (scalar) {
    const f = { appId, ['data.' + scalar.field]: scalar.value }
    results.push(
      await run(`find({appId,'data.${scalar.field}':...}).sort({createdAt:-1}).limit(5)   [filter feature]`, async () => {
        const r = await coll.find(f).sort({ createdAt: -1 }).limit(5).toArray()
        return `${r.length} row(s)`
      }),
    )
    // with skip — the real paginated shape (page 2)
    results.push(
      await run(`...same filter... .skip(${PS}).limit(${PS})   [filter feature, page 2]`, async () => {
        const r = await coll.find(f).sort({ createdAt: -1 }).skip(PS).limit(PS).toArray()
        return `${r.length} row(s)`
      }),
    )
  }

  // 4) free-text _search regex + createdAt sort — the "search box"
  if (token) {
    const f = { appId, _search: { $regex: escapeRegex(token.toLowerCase()) } }
    results.push(
      await run(`find({appId,_search:{$regex:"${token.toLowerCase()}"}}).sort({createdAt:-1}).limit(5)   [search box]`, async () => {
        const r = await coll.find(f).sort({ createdAt: -1 }).limit(5).toArray()
        return `${r.length} row(s)`
      }),
    )
    results.push(
      await run('...same _search regex... countDocuments   [search total]', async () => {
        const n = await coll.countDocuments(f)
        return `total=${n}`
      }),
    )
  }

  // 5) sort BY a data field — almost certainly unservable (no {appId,'data.<f>'} index)
  if (scalar) {
    results.push(
      await run(`find({appId}).sort({'data.${scalar.field}':1}).limit(5)   [sort by app field]`, async () => {
        const r = await coll.find({ appId }).sort({ ['data.' + scalar.field]: 1 }).limit(5).toArray()
        return `${r.length} row(s)`
      }),
    )
  }

  // 6) distinct on a data field — the dropdown / status-chips source
  if (scalar) {
    results.push(
      await run(`distinct('data.${scalar.field}', {appId})   [filter dropdown]`, async () => {
        const v = await coll.distinct('data.' + scalar.field, { appId })
        return `${v.length} distinct value(s)`
      }),
    )
  }

  // --- summary ---
  console.log('\n' + '='.repeat(72))
  console.log('SUMMARY  (paste this back)')
  console.log('='.repeat(72))
  for (const r of results) {
    console.log(`  ${r.ok ? 'SERVED ' : 'BLOCKED'}  ${r.label.split('   [')[0]}`)
  }
  const blocked = results.filter((r) => !r.ok)
  console.log(
    `\n${blocked.length === 0 ? 'All probed shapes are SERVED on this account.' : `${blocked.length} shape(s) BLOCKED — these features will fail on deploy until fixed.`}\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // MongoClient keeps a socket open; exit explicitly once done.
  main().finally(() => process.exit(process.exitCode || 0))
}
