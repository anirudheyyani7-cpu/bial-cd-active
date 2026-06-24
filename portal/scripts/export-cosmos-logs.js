/**
 * Export user-interaction logs + token utilization from the Cosmos (Mongo) store
 * into a clearly-presentable, multi-sheet Excel workbook.
 *
 *   node scripts/export-cosmos-logs.js                                  # last 7 days, all users
 *   node scripts/export-cosmos-logs.js --last 24h                       # rolling 24h window
 *   node scripts/export-cosmos-logs.js --last 1w --user a@b.com         # past week, one user
 *   node scripts/export-cosmos-logs.js --from 2026-06-01 --to 2026-06-20
 *   node scripts/export-cosmos-logs.js --date 2026-06-17 --dry-run      # counts only, no file
 *   node scripts/export-cosmos-logs.js --help
 *
 * READ-ONLY: this script only issues `.find()` reads — it never writes to the DB.
 * It loads whatever `MONGODB_URI` / `.env` is in scope (dotenv), same as the seed
 * scripts, and reuses the cosmos.js collection getters.
 *
 * Dates are interpreted in IST (Asia/Kolkata, UTC+5:30) to match how the product
 * buckets daily token usage. Output is written under ./exports/ (gitignored — it
 * contains conversation content / PII).
 *
 * NOTE on tokens: usage is aggregated per-user-per-IST-day only (the product
 * stores no per-message, per-model, or cost figures), so the Transcript sheet
 * shows the interaction and the Daily Token Usage sheet shows utilization — they
 * cannot be joined per message.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as XLSX from 'xlsx'
import {
  getConversationsCollection,
  getMessagesCollection,
  getUsageCollection,
} from '../server/cosmos.js'

const IST_OFFSET = '+05:30' // Asia/Kolkata has no DST, so a fixed offset is exact.
const MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const MAX_MESSAGES_PER_CONVERSATION = 5000
const MAX_CELL = 32_000 // Excel's hard cell limit is 32767 chars; stay under it.

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests; no DB or process access in here)
// ---------------------------------------------------------------------------

/** Parse a `--last` spec like "24h" / "7d" / "1w" into milliseconds. */
export function parseLast(spec) {
  const m = String(spec).trim().match(/^(\d+)\s*([hdw])$/i)
  if (!m) throw new Error(`Invalid --last "${spec}". Use e.g. 24h, 7d, 1w.`)
  return Number(m[1]) * MS[m[2].toLowerCase()]
}

function assertDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`)
}

/** The UTC instant of 00:00 IST on the given YYYY-MM-DD calendar day. */
function istDayStart(dayStr) {
  return new Date(`${dayStr}T00:00:00${IST_OFFSET}`)
}

/** The YYYY-MM-DD IST calendar day a given instant falls on. */
export function istDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date)
}

/** Human-readable IST timestamp for a stored ISO string (falls back to raw). */
export function istFormat(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d)
  return `${s} IST`
}

/**
 * Flatten a message `parts[]` array into a printable transcript cell + a separate
 * attachments summary. Text parts are joined by newlines; file parts become a
 * "name (mediaType, N bytes)" summary (the bytes themselves live in object store).
 */
export function flattenParts(parts) {
  if (!Array.isArray(parts)) return { text: '', attachments: '' }
  const texts = []
  const files = []
  for (const p of parts) {
    if (p?.type === 'text') texts.push(p.text ?? '')
    else if (p?.type === 'file') {
      files.push(`${p.name ?? p.attachmentId ?? 'file'} (${p.mediaType ?? p.kind ?? '?'}, ${p.size ?? '?'} bytes)`)
    }
  }
  return { text: texts.join('\n'), attachments: files.join('; ') }
}

/**
 * Resolve CLI date options into a query window. Explicit --from/--to/--date are
 * IST calendar days (inclusive); otherwise --last (default 7d) is a rolling
 * instant window ending now. Returns instants for the conversations/messages
 * `createdAt`/`updatedAt` range and YYYY-MM-DD day bounds for the token filter.
 */
export function resolveWindow(args, now = new Date()) {
  if (args.from || args.to || args.date) {
    const fromDay = args.date || args.from
    const toDay = args.date || args.to || fromDay
    if (!fromDay) throw new Error('Provide --from (with optional --to) or --date.')
    assertDay(fromDay)
    assertDay(toDay)
    if (toDay < fromDay) throw new Error(`--to (${toDay}) is before --from (${fromDay}).`)
    return {
      fromInstant: istDayStart(fromDay),
      toExclusiveInstant: new Date(istDayStart(toDay).getTime() + MS.d), // end of toDay IST
      fromDay,
      toDay,
      label: fromDay === toDay ? fromDay : `${fromDay}_to_${toDay}`,
    }
  }
  const spec = args.last || '7d'
  const fromInstant = new Date(now.getTime() - parseLast(spec))
  return {
    fromInstant,
    toExclusiveInstant: now,
    fromDay: istDay(fromInstant),
    toDay: istDay(now),
    label: `last-${spec}`,
  }
}

function cap(value) {
  const s = String(value ?? '')
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…[truncated]` : s
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--user' || a === '--username') args.user = argv[++i]
    else if (a === '--from') args.from = argv[++i]
    else if (a === '--to') args.to = argv[++i]
    else if (a === '--date') args.date = argv[++i]
    else if (a === '--last') args.last = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '-h' || a === '--help') args.help = true
    else throw new Error(`Unknown argument: ${a} (try --help)`)
  }
  return args
}

function printHelp() {
  console.log(`
Export Cosmos interaction logs + token usage to an Excel (.xlsx) workbook.

Usage: node scripts/export-cosmos-logs.js [options]

  --user <email[,email]>  filter to one or more usernames (lowercased). Default: all users.
  --from <YYYY-MM-DD>     start date, IST, inclusive.
  --to   <YYYY-MM-DD>     end date, IST, inclusive (defaults to --from).
  --date <YYYY-MM-DD>     shorthand for a single IST day (--from == --to).
  --last <N>h|d|w         rolling window ending now, e.g. 24h, 7d, 1w.
  --out  <path>           output .xlsx path. Default: ./exports/cosmos-logs_<range>[_<user>].xlsx
  --dry-run               connect + print counts only; write no file.
  -h, --help              show this help.

If no date option is given, the default window is the last 7 days.
Dates are interpreted in IST (Asia/Kolkata). Read-only — never writes to the DB.

Output workbook sheets: Summary | Daily Token Usage | Conversations | Transcript.
`)
}

function defaultOutPath(win, users) {
  const userTag = users && users.length === 1 ? `_${users[0].replace(/[^a-z0-9.@_-]/gi, '_')}` : ''
  return path.join('exports', `cosmos-logs_${win.label}${userTag}.xlsx`)
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

function buildWorkbook({ win, users, conversations, transcript, usage, perUser }) {
  const wb = XLSX.utils.book_new()

  const summary = [
    ['BIAL portal — Cosmos interaction & token-usage export'],
    [],
    ['Window (IST)', win.fromDay === win.toDay ? win.fromDay : `${win.fromDay} → ${win.toDay}`],
    ['Window (instants, UTC)', `${win.fromInstant.toISOString()} → ${win.toExclusiveInstant.toISOString()}`],
    ['Users', users ? users.join(', ') : 'ALL'],
    ['Generated at', istFormat(new Date().toISOString())],
    ['Conversations', conversations.length],
    ['Messages', transcript.length],
    [],
    ['Note', 'Token usage is aggregated per-user-per-IST-day only (no per-message/per-model/cost data).'],
    [],
    ['Username', 'Conversations', 'User msgs', 'Assistant msgs', 'Input tokens', 'Output tokens', 'Total tokens'],
    ...[...perUser.values()]
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((u) => [
        u.username,
        u.conversations,
        u.userMsgs,
        u.asstMsgs,
        u.inputTokens,
        u.outputTokens,
        u.inputTokens + u.outputTokens,
      ]),
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary')

  const usageRows = [['Username', 'Date (IST)', 'Input tokens', 'Output tokens', 'Total tokens']]
  let ti = 0
  let to = 0
  for (const u of usage) {
    const input = u.inputTokens ?? 0
    const output = u.outputTokens ?? 0
    ti += input
    to += output
    usageRows.push([u.username, u.date, input, output, input + output])
  }
  usageRows.push(['TOTAL', '', ti, to, ti + to])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(usageRows), 'Daily Token Usage')

  const convRows = [['Conversation ID', 'Username', 'Kind', 'Title', 'Created (IST)', 'Updated (IST)', 'Messages']]
  for (const c of conversations) {
    convRows.push([
      c._id,
      c.username,
      c.kind ?? '',
      cap(c.title ?? ''),
      istFormat(c.createdAt),
      istFormat(c.updatedAt),
      c._messageCount ?? 0,
    ])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(convRows), 'Conversations')

  const txRows = [
    ['Timestamp (IST)', 'Username', 'Conversation ID', 'Title', 'Kind', 'Seq', 'Role', 'Text', 'Attachments'],
  ]
  for (const t of transcript) {
    txRows.push([t.timestamp, t.username, t.conversationId, cap(t.title), t.kind, t.seq, t.role, t.text, t.attachments])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txRows), 'Transcript')

  return wb
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const users = args.user
    ? args.user.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null
  const win = resolveWindow(args)

  const convCol = await getConversationsCollection()
  const msgCol = await getMessagesCollection()
  const usageCol = await getUsageCollection()

  // Conversations active in the window. Single-user uses the {username, updatedAt}
  // index; all-users fans out cross-partition (fine for an admin export).
  const convFilter = {
    ...(users ? { username: { $in: users } } : {}),
    updatedAt: { $gte: win.fromInstant.toISOString(), $lt: win.toExclusiveInstant.toISOString() },
  }
  const conversations = await convCol.find(convFilter).toArray()
  conversations.sort(
    (a, b) =>
      String(a.username ?? '').localeCompare(String(b.username ?? '')) ||
      String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
  )

  // Per-conversation messages via the ONLY servable sort on this account: seq.
  const transcript = []
  const perUser = new Map()
  const bucket = (name) => {
    const key = name ?? '(unknown)'
    if (!perUser.has(key)) {
      perUser.set(key, { username: key, conversations: 0, userMsgs: 0, asstMsgs: 0, inputTokens: 0, outputTokens: 0 })
    }
    return perUser.get(key)
  }

  for (const c of conversations) {
    bucket(c.username).conversations += 1
    const msgs = await msgCol
      .find({ conversationId: c._id, username: c.username })
      .sort({ seq: 1 })
      .limit(MAX_MESSAGES_PER_CONVERSATION)
      .toArray()
    c._messageCount = msgs.length
    for (const m of msgs) {
      const { text, attachments } = flattenParts(m.parts)
      const b = bucket(m.username)
      if (m.role === 'assistant') b.asstMsgs += 1
      else b.userMsgs += 1
      transcript.push({
        timestamp: istFormat(m.createdAt),
        username: m.username,
        conversationId: c._id,
        title: c.title ?? '',
        kind: c.kind ?? '',
        seq: m.seq,
        role: m.role,
        text: cap(text),
        attachments: cap(attachments),
      })
    }
  }

  // Token usage for the same users × IST-day range (string range == chronological).
  const usageFilter = {
    ...(users ? { username: { $in: users } } : {}),
    date: { $gte: win.fromDay, $lte: win.toDay },
  }
  const usage = await usageCol.find(usageFilter).toArray()
  usage.sort(
    (a, b) =>
      String(a.username ?? '').localeCompare(String(b.username ?? '')) ||
      String(a.date ?? '').localeCompare(String(b.date ?? '')),
  )
  for (const u of usage) {
    const b = bucket(u.username)
    b.inputTokens += u.inputTokens ?? 0
    b.outputTokens += u.outputTokens ?? 0
  }

  const rangeLabel = win.fromDay === win.toDay ? win.fromDay : `${win.fromDay} → ${win.toDay}`
  console.log(
    `Window ${rangeLabel} (IST) · users: ${users ? users.join(', ') : 'ALL'} · ` +
      `${conversations.length} conversations · ${transcript.length} messages · ${usage.length} usage rows`,
  )

  if (args.dryRun) {
    console.log('Dry run — no file written.')
    return
  }

  if (conversations.length === 0 && usage.length === 0) {
    console.log('Nothing matched the window; writing an empty workbook anyway for the record.')
  }

  const outPath = args.out || defaultOutPath(win, users)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const wb = buildWorkbook({ win, users, conversations, transcript, usage, perUser })
  XLSX.writeFile(wb, outPath)
  console.log(`Wrote ${outPath}`)
}

// MongoClient keeps a socket open; exit explicitly once done (repo convention).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error('export-cosmos-logs failed:', err.message)
      process.exitCode = 1
    })
    .finally(() => process.exit(process.exitCode || 0))
}
