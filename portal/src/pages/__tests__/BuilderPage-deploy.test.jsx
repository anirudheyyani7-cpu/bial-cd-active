import { describe, it, expect } from 'vitest'
import { usesDataService, extractDataSchema } from '../BuilderPage.jsx'

describe('BuilderPage — data-wiring detection helpers (U11)', () => {
  it('usesDataService is true only when the generated code calls BIALData', () => {
    expect(usesDataService('function PreviewApp(){ const r = await BIALData.list("default") }')).toBe(true)
    expect(usesDataService('function PreviewApp(){ return <div>view only</div> }')).toBe(false)
    expect(usesDataService(null)).toBe(false)
    expect(usesDataService('// mentions BIALDataStore but not the global')).toBe(false) // word boundary
  })

  it('extractDataSchema pins the first BIALData collection name', () => {
    expect(extractDataSchema("BIALData.save('inspections', { gate: 4 })")).toEqual({ collection: 'inspections' })
    expect(extractDataSchema('BIALData.list("equipment", { limit: 50 })')).toEqual({ collection: 'equipment' })
    expect(extractDataSchema('no data calls here')).toBeNull()
    expect(extractDataSchema(undefined)).toBeNull()
  })
})
