import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../auth/password.js'

describe('password (argon2id)', () => {
  it('hashes to a $argon2id$ PHC string', async () => {
    const phc = await hashPassword('correct horse battery staple')
    expect(phc).toMatch(/^\$argon2id\$/)
  })

  it('verifyPassword returns true for the matching password', async () => {
    const phc = await hashPassword('s3cret-pass-phrase')
    await expect(verifyPassword('s3cret-pass-phrase', phc)).resolves.toBe(true)
  })

  it('verifyPassword returns false for a wrong password', async () => {
    const phc = await hashPassword('s3cret-pass-phrase')
    await expect(verifyPassword('wrong-password', phc)).resolves.toBe(false)
  })

  it('verifyPassword returns false for a malformed hash instead of throwing', async () => {
    await expect(verifyPassword('whatever', 'not-a-phc-string')).resolves.toBe(false)
  })

  it('two hashes of the same password differ (random salt)', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
  })
})
