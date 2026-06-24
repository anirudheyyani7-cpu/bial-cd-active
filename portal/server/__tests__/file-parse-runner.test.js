import { describe, it, expect } from 'vitest'
import { parseInWorker } from '../file-parse-runner.js'
import { parseFile } from '../file-parse.js'
import { EXCEL_TYPE, makeXlsx } from './officeFixtures.js'

describe('parseInWorker', () => {
  it('returns the same structured result as the in-process parser', async () => {
    const buffer = makeXlsx([{ name: 'Data', aoa: [['City', 'Pax'], ['DEL', 220], ['BOM', 180]] }])
    const viaWorker = await parseInWorker({ buffer, contentType: EXCEL_TYPE, filename: 'd.xlsx' })
    const inProcess = await parseFile({ buffer, contentType: EXCEL_TYPE, filename: 'd.xlsx' })
    expect(viaWorker).toEqual(inProcess)
  })

  it('propagates a parse error as a FileParseError with status + code', async () => {
    await expect(
      parseInWorker({ buffer: Buffer.from('%PDF-1.4'), contentType: 'application/pdf', filename: 'x.pdf' }),
    ).rejects.toMatchObject({ name: 'FileParseError', status: 415, code: 'UNSUPPORTED_TYPE' })
  })

  it('terminates and rejects (413 PARSE_TIMEOUT) when the parse overruns the budget', async () => {
    const buffer = makeXlsx([{ name: 'S', aoa: [['a'], [1]] }])
    await expect(
      parseInWorker({ buffer, contentType: EXCEL_TYPE, filename: 's.xlsx', __testDelayMs: 1000 }, { timeoutMs: 80 }),
    ).rejects.toMatchObject({ name: 'FileParseError', status: 413, code: 'PARSE_TIMEOUT' })
  })
})
