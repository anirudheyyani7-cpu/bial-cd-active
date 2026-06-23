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

  it('ignores the removed dataSource/hasSchema options — emits neither line, and with no other options returns the base prompt', () => {
    const prompt = buildSystemPrompt({ dataSource: 'aodb', hasSchema: true })
    expect(prompt).not.toContain('Data source selected')
    expect(prompt).not.toContain('Backend schema requested')
    // those were the only options → no Session Context block, base prompt unchanged
    expect(prompt).not.toContain('## Session Context')
    expect(prompt).toBe(buildSystemPrompt())
  })

  it('an empty context returns the base prompt with no Session Context block', () => {
    const prompt = buildSystemPrompt({})
    expect(prompt).toBe(buildSystemPrompt())
    expect(prompt).not.toContain('## Session Context')
  })

  it('a selected theme emits the UI-style line in the Session Context', () => {
    const prompt = buildSystemPrompt({ theme: 'bial' })
    expect(prompt).toContain('## Session Context')
    expect(prompt).toContain('UI style selected')
    expect(prompt).toContain('Bangalore Airport Theme')
  })

  it('an uploaded file is treated as real input to view client-side or seed — never hardcoded', () => {
    const prompt = buildSystemPrompt({ uploadedFiles: [{ name: 'equipment.csv', content: 'tag\nGEN-1' }] })
    expect(prompt).toContain('Uploaded reference data')
    expect(prompt).toContain('BIALData.seedFromUpload')
    expect(prompt).toMatch(/never paste these rows in as hardcoded data/i)
    expect(prompt).toContain('equipment.csv') // the file content is still included
    expect(prompt).toContain('GEN-1')
  })

  it('documents the File storage section + all BIALData file method names (collection-first listFiles)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('File storage')
    for (const m of ['BIALData.uploadFile', 'BIALData.listFiles', 'BIALData.getFile', 'BIALData.downloadFile', 'BIALData.fileObjectUrl', 'BIALData.removeFile']) {
      expect(prompt).toContain(m)
    }
    // listFiles is documented collection-first, mirroring list
    expect(prompt).toMatch(/listFiles\(collection/)
    expect(prompt).toMatch(/COLLECTION-FIRST/i)
    // the wiring question now covers files too, but keeps the "refresh or be shared" discriminator
    expect(prompt).toMatch(/files.*survive a page refresh or be shared/i)
    // no fabricated-data phrasing slips in via the new section
    expect(prompt).not.toMatch(/placeholder data|dummy data|mock data/i)
  })

  it('makes the downloadFile (save-to-disk) vs fileObjectUrl (render/re-parse) intent distinction selectable', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/downloadFile.*SAVE the file to the user/i) // save-to-disk
    expect(prompt).toMatch(/fileObjectUrl.*render or re-parse|render or re-parse the file/i) // in-app render/re-parse
    expect(prompt).toMatch(/<img src>/) // the render path is concrete
    expect(prompt).toMatch(/Choose by INTENT/i)
  })

  it('teaches combining files + records with the reconciliation worked example (report file + records; source sheets opt-in)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/Combining files \+ records/i)
    expect(prompt).toMatch(/reconciliation/i)
    expect(prompt).toMatch(/persist the generated report as a file/i) // report → file by default
    expect(prompt).toMatch(/reportFileId/) // link the record to the file by id
    expect(prompt).toMatch(/data minimization/i) // source sheets default off
    expect(prompt).toMatch(/opt-in/i) // source sheets are an explicit opt-in
    expect(prompt).toMatch(/sensitive files MUST require login|MUST require login/i) // sensitive-file login
  })

  it('keeps the pure view-only archetype client-side (no file/backend calls when nothing is kept)', () => {
    const prompt = buildSystemPrompt()
    // wiring 1 still mandates client-side state with no backend/login for parse-and-discard apps
    expect(prompt).toMatch(/view-only.*keeps nothing[\s\S]*NO backend, NO login/i)
  })

  it('the uploadedFiles augmentation offers persisting the ORIGINAL file when it must be kept (with sensitive-file login)', () => {
    const prompt = buildSystemPrompt({ uploadedFiles: [{ name: 'sheet.csv', content: 'a\n1' }] })
    expect(prompt).toMatch(/ORIGINAL file kept or re-downloadable/i)
    expect(prompt).toContain('BIALData.uploadFile')
    expect(prompt).toMatch(/require login if it may hold sensitive data/i)
  })

  it('a pinned dataSchema injects the exact collection + field names with a do-not-rename rule; absent → omitted', () => {
    const pinned = buildSystemPrompt({ dataSchema: { collection: 'inspections', fields: ['gate', 'status'] } })
    expect(pinned).toMatch(/reuse these EXACT collection and field names/i)
    expect(pinned).toContain('inspections')
    expect(pinned).toContain('gate, status')
    expect(pinned).toMatch(/do NOT rename/i)

    const none = buildSystemPrompt({ theme: 'bial' })
    expect(none).not.toMatch(/reuse these EXACT/i)
  })
})
