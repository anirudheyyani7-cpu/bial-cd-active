import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { deckAttachmentsEnabled, gotenbergUrl, maxDeckPages } from '../deck-config.js'

const KEYS = ['DECK_ATTACHMENTS_ENABLED', 'GOTENBERG_URL', 'MAX_DECK_PAGES']

describe('deck-config', () => {
  let saved
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  describe('deckAttachmentsEnabled', () => {
    it('is disabled when neither flag nor URL is set', () => {
      expect(deckAttachmentsEnabled()).toBe(false)
    })
    it('is disabled when the flag is on but GOTENBERG_URL is unset', () => {
      process.env.DECK_ATTACHMENTS_ENABLED = 'true'
      expect(deckAttachmentsEnabled()).toBe(false)
    })
    it('is disabled when GOTENBERG_URL is set but the flag is off', () => {
      process.env.GOTENBERG_URL = 'http://localhost:3000'
      expect(deckAttachmentsEnabled()).toBe(false)
    })
    it('is disabled when the flag is a truthy-but-not-"true" value', () => {
      process.env.DECK_ATTACHMENTS_ENABLED = '1'
      process.env.GOTENBERG_URL = 'http://localhost:3000'
      expect(deckAttachmentsEnabled()).toBe(false)
    })
    it('is enabled when the flag is "true" AND GOTENBERG_URL is set', () => {
      process.env.DECK_ATTACHMENTS_ENABLED = 'true'
      process.env.GOTENBERG_URL = 'http://localhost:3000'
      expect(deckAttachmentsEnabled()).toBe(true)
    })
  })

  describe('gotenbergUrl', () => {
    it('returns "" when unset', () => {
      expect(gotenbergUrl()).toBe('')
    })
    it('trims trailing slashes', () => {
      process.env.GOTENBERG_URL = 'http://localhost:3000///'
      expect(gotenbergUrl()).toBe('http://localhost:3000')
    })
    it('trims surrounding whitespace', () => {
      process.env.GOTENBERG_URL = '  http://gotenberg:3000  '
      expect(gotenbergUrl()).toBe('http://gotenberg:3000')
    })
  })

  describe('maxDeckPages', () => {
    it('defaults to 100', () => {
      expect(maxDeckPages()).toBe(100)
    })
    it('honors a positive integer override', () => {
      process.env.MAX_DECK_PAGES = '250'
      expect(maxDeckPages()).toBe(250)
    })
    it('falls back to the default on zero/negative/garbage', () => {
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env.MAX_DECK_PAGES = bad
        expect(maxDeckPages()).toBe(100)
      }
    })
  })
})
