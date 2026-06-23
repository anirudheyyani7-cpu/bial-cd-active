import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../../hooks/useClaudeAPI.js'

describe('buildSystemPrompt — no fabricated data, real Data Service wiring (U12)', () => {
  it('the base prompt drops the placeholder/mock-data instructions and documents the BIALData + login API', () => {
    const prompt = buildSystemPrompt()
    // the old fabrication instructions are gone
    expect(prompt).not.toContain('realistic placeholder data')
    expect(prompt).not.toContain('Include realistic placeholder')
    expect(prompt).not.toContain('mock data consistent')
    // a no-fabrication rule is present
    expect(prompt).toMatch(/never fabricate data|Do NOT hardcode/i)
    expect(prompt).toMatch(/empty \/ loading \/ error/i)
    // the CRUD + login API contract is embedded
    expect(prompt).toContain('BIALData.save(collection, data)')
    expect(prompt).toContain('BIALData.list(collection')
    expect(prompt).toContain('BIALData.update(collection')
    expect(prompt).toContain('BIALData.remove(collection')
    expect(prompt).toContain('BIALData.seedFromUpload')
    expect(prompt).toContain('BIALData.login')
    expect(prompt).toContain('currentUser')
  })

  it('documents save() with the REAL nested record shape (fields under .data), not a flattened { id, ...data }', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).not.toContain('{ id, ...data }') // the wrong, flattened shape must be gone
    expect(prompt).toMatch(/save\(collection, data\)`?\s*→\s*the created record `\{ id, data/) // nested, consistent with list/get
    expect(prompt).toMatch(/nested under `\.data`/i)
  })

  it('still names PreviewApp, the jsx:preview fence, classic-runtime globals, and no imports/exports', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('PreviewApp')
    expect(prompt).toContain('jsx:preview')
    expect(prompt).toContain('Do NOT use import or export')
    expect(prompt).toMatch(/available globally/)
  })

  it('teaches the three data wirings keyed on "must data persist/share?"', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/view-only/i) // upload-only, client-side, no backend/login
    expect(prompt).toMatch(/persistent records/i) // CRUD via BIALData + login
    expect(prompt).toMatch(/reference data/i) // CRUD-with-seed (seedFromUpload)
    expect(prompt).toMatch(/refresh or be shared/i) // the discriminator
  })

  it('a selected data source maps to the REAL record shape via the Data Service, not mock data', () => {
    const prompt = buildSystemPrompt({ dataSource: 'aodb' })
    expect(prompt).toContain('Data source selected')
    expect(prompt).toMatch(/REAL records|entity\/field names|entities and field names/i)
    expect(prompt).not.toMatch(/use .*mock data consistent/i)
  })

  it('an uploaded file is treated as real input to view client-side or seed — never hardcoded', () => {
    const prompt = buildSystemPrompt({ uploadedFiles: [{ name: 'equipment.csv', content: 'tag\nGEN-1' }] })
    expect(prompt).toContain('Uploaded reference data')
    expect(prompt).toContain('BIALData.seedFromUpload')
    expect(prompt).toMatch(/never paste these rows in as hardcoded data/i)
    expect(prompt).toContain('equipment.csv') // the file content is still included
    expect(prompt).toContain('GEN-1')
  })

  it('a pinned dataSchema injects the exact collection + field names with a do-not-rename rule; absent → omitted', () => {
    const pinned = buildSystemPrompt({ dataSchema: { collection: 'inspections', fields: ['gate', 'status'] } })
    expect(pinned).toMatch(/reuse these EXACT collection and field names/i)
    expect(pinned).toContain('inspections')
    expect(pinned).toContain('gate, status')
    expect(pinned).toMatch(/do NOT rename/i)

    const none = buildSystemPrompt({ dataSource: 'aodb' })
    expect(none).not.toMatch(/reuse these EXACT/i)
  })
})
