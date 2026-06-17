import { describe, it, expect } from 'vitest'

// Proves the Vitest + node-project wiring runs before any real suite lands.
describe('test harness', () => {
  it('executes and asserts', () => {
    expect(1 + 1).toBe(2)
  })
})
