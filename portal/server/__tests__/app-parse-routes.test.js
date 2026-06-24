import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAppParseRouter, makeAppParseLimiter } from '../app-parse.js'
import { createAppFilesRouter, APP_FILE_MAX_JSON } from '../app-files.js'
import { makeDataServiceCors, APP_DATA_BODY_LIMIT } from '../app-data.js'
import { createAppFilesRepo } from '../app-files-repo.js'
import { createAppRegistryRepo } from '../app-registry-repo.js'
import { createAuditRepo } from '../audit-repo.js'
import { makeFakeAppRegistryContainer } from './fakeAppRegistryCosmos.js'
import { makeFakeAppFilesContainer } from './fakeAppFilesCosmos.js'
import { makeFakeAuditContainer } from './fakeAuditCosmos.js'
import { makeFakeObjectStore } from './fakeObjectStore.js'
import { signAccessToken } from '../auth/tokens.js'
import { EXCEL_TYPE, WORD_TYPE, makeXlsx, makeDocx, para, heading } from './officeFixtures.js'

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test-secret-1234'
})

const CSV_TYPE = 'text/csv'

const SEED = [
  { _id: 'app-open', appKey: 'key-open', status: 'approved', loginRequired: false, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
  { _id: 'app-login', appKey: 'key-login', status: 'approved', loginRequired: true, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
  { _id: 'app-B', appKey: 'key-B', status: 'approved', loginRequired: false, fileCount: 0, fileBytes: 0, dataCount: 0, dataBytes: 0 },
]

function harness({ seed = SEED, limiter, runParse } = {}) {
  const registryRepo = createAppRegistryRepo(makeFakeAppRegistryContainer(seed))
  const appFilesRepo = createAppFilesRepo(makeFakeAppFilesContainer([]), registryRepo)
  const auditRepo = createAuditRepo(makeFakeAuditContainer([]))
  const objectStore = makeFakeObjectStore()
  const app = express()
  // Mirror server.js mount order: scoped CORS, the /files + /parse 25 MB parsers
  // BEFORE the broad /api/apps 256 KB parser, then the routers.
  app.use('/api/apps', makeDataServiceCors())
  app.use('/api/apps/:appId/files', express.json({ limit: APP_FILE_MAX_JSON }))
  app.use('/api/apps/:appId/parse', express.json({ limit: APP_FILE_MAX_JSON }))
  app.use('/api/apps', express.json({ limit: APP_DATA_BODY_LIMIT }))
  app.use('/api/apps/:appId/files', createAppFilesRouter({ appFilesRepo, auditRepo, registryRepo, objectStore }))
  app.use('/api/apps/:appId/parse', createAppParseRouter({ appFilesRepo, registryRepo, objectStore, runParse }, { limiter }))
  return { app }
}

const token = (sub = 'alice') => signAccessToken({ sub, username: sub, role: 'user' })
const b64 = (buf) => Buffer.from(buf).toString('base64')
const parseUrl = (appId) => `/api/apps/${appId}/parse`
const filesUrl = (appId) => `/api/apps/${appId}/files`
const postParse = (app, appId, body, key = `key-${appId.replace('app-', '')}`) =>
  request(app).post(parseUrl(appId)).set('X-App-Key', key).send(body)

const FLIGHTS_XLSX = () =>
  makeXlsx([
    { name: 'Flights', aoa: [['Destination', 'Passengers'], ['DEL', 220], ['BOM', 180]] },
    { name: 'Crew', aoa: [['Name', 'Role'], ['Asha', 'Pilot']] },
  ])

describe('app-parse routes — inline (view-only) parse', () => {
  it('parses inline xlsx bytes into rows + sheet names (nothing stored)', async () => {
    const { app } = harness()
    const res = await postParse(app, 'app-open', {
      filename: 'flights.xlsx',
      contentType: EXCEL_TYPE,
      base64: b64(FLIGHTS_XLSX()),
    })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('spreadsheet')
    expect(res.body.sheets).toEqual(['Flights', 'Crew'])
    expect(res.body.sheet).toBe('Flights')
    expect(res.body.columns).toEqual(['Destination', 'Passengers'])
    expect(res.body.rows).toEqual([
      { Destination: 'DEL', Passengers: 220 },
      { Destination: 'BOM', Passengers: 180 },
    ])
  })

  it('parses a chosen worksheet via { sheet }', async () => {
    const { app } = harness()
    const res = await postParse(app, 'app-open', { filename: 'f.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()), sheet: 'Crew' })
    expect(res.status).toBe(200)
    expect(res.body.sheet).toBe('Crew')
    expect(res.body.rows).toEqual([{ Name: 'Asha', Role: 'Pilot' }])
  })

  it('parses inline CSV bytes into rows', async () => {
    const { app } = harness()
    const res = await postParse(app, 'app-open', { filename: 'd.csv', contentType: CSV_TYPE, base64: b64('Gate,Flights\nA1,12\nA2,7\n') })
    expect(res.status).toBe(200)
    expect(res.body.columns).toEqual(['Gate', 'Flights'])
    expect(res.body.rows).toEqual([{ Gate: 'A1', Flights: 12 }, { Gate: 'A2', Flights: 7 }])
  })

  it('parses inline Word bytes into text', async () => {
    const { app } = harness()
    const docx = await makeDocx(heading(1, 'Ops Note') + para('Runway 09 closed.'))
    const res = await postParse(app, 'app-open', { filename: 'note.docx', contentType: WORD_TYPE, base64: b64(docx) })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('document')
    expect(res.body.text).toContain('# Ops Note')
    expect(res.body.text).toContain('Runway 09 closed.')
  })
})

describe('app-parse routes — stored-file parse (list → pick → view)', () => {
  it('re-parses a previously uploaded file by id', async () => {
    const { app } = harness()
    const up = await request(app)
      .post(filesUrl('app-open'))
      .set('X-App-Key', 'key-open')
      .send({ filename: 'stored.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()) })
    expect(up.status).toBe(201)
    const fileId = up.body.fileId

    const res = await postParse(app, 'app-open', { fileId, sheet: 'Crew' })
    expect(res.status).toBe(200)
    expect(res.body.sheet).toBe('Crew')
    expect(res.body.rows).toEqual([{ Name: 'Asha', Role: 'Pilot' }])
  })

  it('404s a foreign / unknown fileId (tenant isolation)', async () => {
    const { app } = harness()
    const up = await request(app)
      .post(filesUrl('app-B'))
      .set('X-App-Key', 'key-B')
      .send({ filename: 's.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()) })
    const bId = up.body.fileId
    const res = await postParse(app, 'app-open', { fileId: bId }) // app-open cannot reach app-B's file
    expect(res.status).toBe(404)
  })
})

describe('app-parse routes — validation + errors', () => {
  it('rejects an unsupported type with 415', async () => {
    const { app } = harness()
    const res = await postParse(app, 'app-open', { filename: 'doc.pdf', contentType: 'application/pdf', base64: b64('%PDF-1.4') })
    expect(res.status).toBe(415)
    expect(res.body.error.code).toBe('UNSUPPORTED_TYPE')
  })

  it('rejects a mislabelled non-zip .xlsx (structure check) with 400', async () => {
    const { app } = harness()
    const res = await postParse(app, 'app-open', { filename: 'x.xlsx', contentType: EXCEL_TYPE, base64: b64('this is not a zip') })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown worksheet name', async () => {
    const { app } = harness()
    const res = await postParse(app, 'app-open', { filename: 'f.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()), sheet: 'Nope' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('SHEET_NOT_FOUND')
  })

  it('400s when neither fileId nor base64 is provided, and when sheet is not a string', async () => {
    const { app } = harness()
    expect((await postParse(app, 'app-open', { contentType: EXCEL_TYPE })).status).toBe(400)
    expect((await postParse(app, 'app-open', { fileId: 'bad id with spaces' })).status).toBe(400)
    expect((await postParse(app, 'app-open', { filename: 'f.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()), sheet: 123 })).status).toBe(400)
  })

  it('maps a parse-time overrun to 413 PARSE_TIMEOUT (worker runner error mapping)', async () => {
    const runParse = async () => {
      const e = new Error('Parsing took too long and was stopped.')
      e.status = 413
      e.code = 'PARSE_TIMEOUT'
      throw e
    }
    const { app } = harness({ runParse })
    const res = await postParse(app, 'app-open', { filename: 'f.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()) })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PARSE_TIMEOUT')
  })
})

describe('app-parse routes — auth + rate limit', () => {
  it('a login app rejects a parse without a Bearer token (401)', async () => {
    const { app } = harness()
    const res = await request(app)
      .post(parseUrl('app-login'))
      .set('X-App-Key', 'key-login')
      .send({ filename: 'f.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()) })
    expect(res.status).toBe(401)
  })

  it('a login app accepts a parse WITH a Bearer token', async () => {
    const { app } = harness()
    const res = await request(app)
      .post(parseUrl('app-login'))
      .set('X-App-Key', 'key-login')
      .set('Authorization', `Bearer ${token('bob')}`)
      .send({ filename: 'f.xlsx', contentType: EXCEL_TYPE, base64: b64(FLIGHTS_XLSX()) })
    expect(res.status).toBe(200)
  })

  it('the limiter is keyed by appId', async () => {
    const { app } = harness({ limiter: makeAppParseLimiter({ limit: 1 }) })
    const body = { filename: 'f.csv', contentType: CSV_TYPE, base64: b64('a,b\n1,2') }
    expect((await postParse(app, 'app-open', body)).status).toBe(200)
    expect((await postParse(app, 'app-open', body)).status).toBe(429)
    expect((await postParse(app, 'app-B', body)).status).toBe(200) // separate bucket
  })
})
