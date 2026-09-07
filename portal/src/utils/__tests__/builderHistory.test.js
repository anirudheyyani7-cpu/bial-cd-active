import { describe, it, expect } from 'vitest'
import * as builderHistory from '../builderHistory'

describe('builderHistory', () => {
  /**
   * A GUARD, not deleted coverage. `createBuild` used to POST a full round trip to
   * `/api/conversations` before the first turn — but that route's only workspace check was
   * project ownership, so a refused first message still left a titled, empty build chat behind.
   * A build row's parentage rides its first turn now; the wire assertion this file made (the
   * create body carries `kind: 'build'`) lives in `turnStreamApi.test.ts` instead.
   *
   * What remains is a READ store — its absence is asserted so re-adding a create verb is a
   * decision, not an accident.
   */
  it('exports no create verb — a build row is created by its first turn', () => {
    expect('createBuild' in builderHistory).toBe(false)
    expect(builderHistory.createBuild).toBeUndefined()
    // Paired with a liveness assertion so the absence above cannot false-green on a module
    // that failed to load anything at all.
    expect(typeof builderHistory.loadBuilds).toBe('function')
    expect(typeof builderHistory.getBuild).toBe('function')
    expect(typeof builderHistory.deriveTitle).toBe('function')
  })
})
