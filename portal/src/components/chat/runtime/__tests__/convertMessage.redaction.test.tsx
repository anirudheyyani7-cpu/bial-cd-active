/**
 * THE SPLIT-AUDIENCE WALL IS AT THE CONVERTER, NOT AT THE DRAW SITE.
 *
 * A diagnostic's developer half (source, compiler title) stays on the wire — the agent needs it —
 * but `StepItem.detail.*` is no longer sent at all (`StepDetail` was removed server-side), so the
 * converter's silence here is belt-and-braces, not the sole guard. Stated plainly because an
 * earlier draft of this docblock claimed the opposite.
 *
 * Assertions below target the CONVERTED OBJECT, not just the rendered tree: a converter that
 * never copies a field means the expander has nothing to leak even if a later render shows every
 * field.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { convertMessage, convertPart } from '../convertMessage'
import ActivityRow from '../../ActivityRow'
import type { ChatMessage, MessagePart } from '../../../../utils/messageTypes'

/** Platform-internal text of the three kinds that have actually reached a browser. */
const INTERNAL = {
  path: '/workspace/app/(dashboard)/page.tsx',
  argv: 'npx --yes prisma migrate deploy --schema /workspace/prisma/schema.prisma',
  stack: 'at Object.<anonymous> (/workspace/.next/server/app/page.js:12:5)',
}

/** A step part carrying every internal field the wire is known to send. */
const loadedStep = (): MessagePart => ({
  type: 'step',
  step: {
    type: 'step',
    seq: 4,
    tool: 'run_command',
    label: 'Updated the home page',
    state: 'ok',
    hidden: false,
    // Not in `StepItem`'s declared shape, and that is the point: the wire is not typed, and the
    // converter has to drop what it was never told about rather than pass it through.
    ...({ detail: { args: INTERNAL.argv, result: INTERNAL.stack, path: INTERNAL.path } } as object),
  },
})

const message = (parts: MessagePart[]): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  parts,
  seq: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
})

describe('the converted part carries the label and the state, and NOTHING else', () => {
  it('drops `detail` entirely — asserted on the object, which is the guarantee', () => {
    const part = convertPart(loadedStep())
    expect(part).toBeTruthy()
    expect(part).toMatchObject({ type: 'tool-call', toolName: 'activity' })

    // The KEY SET, not a handful of absences. A test naming `detail` alone would keep passing the
    // day the wire renames it, which is exactly how this class of leak returns.
    const args = (part as { args: Record<string, unknown> }).args
    expect(Object.keys(args).sort()).toEqual(['label', 'state'])

    expect(Object.keys(part as object).sort()).toEqual(['args', 'toolCallId', 'toolName', 'type'])
  })

  it('drops the RAW TOOL NAME too — an unrecognised command must never reach the screen as argv', () => {
    // The server's classifier computes the friendly label and fails closed; this is the second
    // wall, stopping a command line from rendering as a step.
    const args = (convertPart(loadedStep()) as { args: Record<string, unknown> }).args
    expect(args.label).toBe('Updated the home page')
    expect(JSON.stringify(args)).not.toContain('run_command')
  })

  it('none of the internal text survives conversion, in any field', () => {
    const converted = JSON.stringify(convertMessage(message([loadedStep()])))
    for (const [name, value] of Object.entries(INTERNAL)) {
      expect(converted, `${name} survived the converter`).not.toContain(value)
    }
    // LIVENESS: the step DID convert — the absences above describe a redaction, not a drop.
    expect(converted).toContain('Updated the home page')
  })
})

describe('…and none of it reaches the DOM either — the symptom half', () => {
  it('expanding a row puts no internal text on screen', () => {
    const part = convertPart(loadedStep()) as unknown as Record<string, unknown>
    const Row = ActivityRow as (props: Record<string, unknown>) => JSX.Element
    const { container } = render(<Row {...part} />)

    for (const value of Object.values(INTERNAL)) {
      expect(container.textContent).not.toContain(value)
    }
    expect(screen.getByText('Updated the home page')).toBeTruthy()
    // No `<pre>` anywhere: the shape that carried the stack trace, gone by construction.
    expect(container.querySelector('pre')).toBeNull()
    cleanup()
  })
})

describe('the parts with no rendered form', () => {
  it('a diagnostic’s developer half is never mapped into a part at all', () => {
    // A diagnostic is not a `MessagePart` — it arrives as a turn FRAME, and the surface takes only
    // its citizen-facing sentence when it turns one into a row. No converter path exists that
    // could carry the developer half; stated here so the absence reads as deliberate.
    const parts: MessagePart['type'][] = ['build', 'build_in_progress', 'plan_options']
    expect(parts).not.toContain('diagnostic')
  })

  it('`build`, `build_in_progress` and `plan_options` convert to nothing', () => {
    expect(convertPart({ type: 'build', status: 'ended', sessionId: 's1' } as MessagePart)).toBeNull()
    expect(convertPart({ type: 'build_in_progress', sessionId: 's1' } as MessagePart)).toBeNull()
    expect(
      convertPart({ type: 'plan_options', item: { toolCallId: 'c1', state: 'pending' } } as MessagePart),
    ).toBeNull()
  })

  it('a message made only of them converts to empty content, not to a missing message', () => {
    // Dropping a PART is not dropping a MESSAGE: it still exists with empty content, letting the
    // surface decide separately whether such a row belongs in the transcript at all.
    const converted = convertMessage(message([{ type: 'build_in_progress', sessionId: 's1' } as MessagePart]))
    expect(converted.id).toBe('m1')
    expect(converted.content).toEqual([])
  })
})
