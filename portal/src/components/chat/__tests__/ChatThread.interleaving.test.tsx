/**
 * THE ORDER A TURN IS READ IN, AND THE STATUS THAT SAYS IT IS THINKING.
 *
 * Two properties, both about what the citizen sees, not about any one module:
 *
 *  1. A turn that wrote, acted, and wrote again renders in THAT order, live or reloaded — the
 *     two paths build `ChatMessage`s differently, and this thread is the only place they land
 *     side by side to compare as DOM.
 *  2. The working status appears while the model reasons and never carries its content, driven
 *     by a reasoning part with no field for reasoning text — "status only" holds by construction.
 *
 * Every case below asserts ORDER, never presence: each one passes a presence check today even
 * with the parts in the wrong order, which is exactly the failure this file exists to catch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import ChatThread from '../ChatThread'
import ChatRuntimeProvider from '../runtime/ChatRuntimeProvider'
import type { ChatMessage, MessagePart } from '../../../utils/messageTypes'
import type { StepItem } from '../../../utils/turnStreamApi'

afterEach(cleanup)

const step = (seq: number, label: string): StepItem => ({
  type: 'step',
  seq,
  tool: 'read_file',
  label,
  state: 'ok',
  hidden: false,
})

function mount(messages: ChatMessage[], isRunning = false) {
  return render(
    <div style={{ height: 600 }}>
      <ChatRuntimeProvider
        messages={messages}
        isRunning={isRunning}
        onNew={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn().mockResolvedValue(undefined)}
      >
        <ChatThread />
      </ChatRuntimeProvider>
    </div>,
  )
}

/**
 * The turn under test, as a sequence of parts: prose, a step, prose, a step, prose.
 *
 * One fixture feeds both shapes below, so a divergence can only come from the shapes themselves
 * and never from two hand-written turns that quietly differ.
 */
const TURN: MessagePart[] = [
  { type: 'text', text: 'Looking at what you already have.' },
  { type: 'step', step: step(1, 'Looking at your visitor screen') },
  { type: 'text', text: 'It is there but nothing saves yet.' },
  { type: 'step', step: step(2, 'Building your visitor screen') },
  { type: 'text', text: 'Now it remembers every visitor.' },
]

/** The LIVE shape: one streaming message carrying every part of the turn. */
const live = (): ChatMessage[] => [{ id: 'a1', role: 'assistant', parts: TURN, seq: 1 }]

/**
 * The RELOAD shape: one message per projected item, which is what `messagesFromProjection`
 * produces from the stored rows. The ids follow its composite-key convention.
 */
const reloaded = (): ChatMessage[] =>
  TURN.map((part, index) => ({
    id: `srv_1_${part.type}_${index}`,
    role: 'assistant' as const,
    parts: [part],
    seq: 1,
  }))

/** Stands for an activity group in a reading order — see `readingOrder`. */
const ACTIVITY = '«activity»'

/**
 * What the thread drew, in order — a paragraph as its own text, an activity group as a marker.
 * Read off the rendered tree, not the fixtures, because the question is what a person reading
 * top to bottom sees.
 *
 * A group is a MARKER rather than its label, deliberately: it's collapsed by default (its rows
 * are not in the DOM), and its summary line is the workspace plan's copy, not this file's — this
 * only pins where the group sits, never its wording.
 */
function readingOrder(container: HTMLElement): string[] {
  const nodes = container.querySelectorAll(
    '[data-testid="assistant-message"] p, [data-testid="activity-group"]',
  )
  return Array.from(nodes)
    .map((node) =>
      node.getAttribute('data-testid') === 'activity-group'
        ? ACTIVITY
        : (node.textContent ?? '').trim(),
    )
    .filter((text) => text !== '')
}

describe('a turn reads the same whether or not the page was reloaded', () => {
  it('renders prose and steps interleaved, in the order they were written', () => {
    const { container } = mount(live())
    expect(readingOrder(container)).toEqual([
      'Looking at what you already have.',
      ACTIVITY,
      'It is there but nothing saves yet.',
      ACTIVITY,
      'Now it remembers every visitor.',
    ])
  })

  it('produces the identical reading order from the reload shape', () => {
    const liveRender = mount(live())
    const liveOrder = readingOrder(liveRender.container)
    cleanup()

    const reloadRender = mount(reloaded())
    expect(readingOrder(reloadRender.container)).toEqual(liveOrder)
  })

  it('groups two adjacent steps as ONE activity group, and prose between them as two', () => {
    // `groupPartByType` coalesces ADJACENT tool-call parts, so the group count is a fact about
    // the turn (whether anything was written between them), not a setting. Two assertions, not
    // one: the same fixture minus its middle paragraph must produce ONE group, or this proves
    // nothing about the paragraph.
    const withProse = mount([{ id: 'a1', role: 'assistant', parts: TURN, seq: 1 }])
    expect(withProse.container.querySelectorAll('[data-testid="activity-group"]')).toHaveLength(2)
    cleanup()

    const adjacent = mount([
      {
        id: 'a1',
        role: 'assistant',
        parts: [TURN[1], TURN[3]] as MessagePart[],
        seq: 1,
      },
    ])
    expect(adjacent.container.querySelectorAll('[data-testid="activity-group"]')).toHaveLength(1)
  })
})

describe('the working status — that the agent is thinking, never what about', () => {
  it('renders one status line for a content-free reasoning part', () => {
    mount([{ id: 'a1', role: 'assistant', parts: [{ type: 'reasoning' }], seq: 1 }], true)

    const status = screen.getByTestId('working-status')
    expect(status.textContent).toBe('Working on your app')
    // ONE line, not one per part: the surface synthesises exactly one while the flag is true,
    // and a second would mean the status was being driven by something that repeats.
    expect(screen.getAllByTestId('working-status')).toHaveLength(1)
  })

  it('shows the status ABOVE the activity group on a turn that is also running steps', () => {
    // The grouping is HIERARCHICAL — reasoning and tool-call parts share a chain-of-thought
    // parent and get separate children — so both render, with the status first because the
    // model thought before it acted.
    const { container } = mount(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [{ type: 'reasoning' }, TURN[1]] as MessagePart[],
          seq: 1,
        },
      ],
      true,
    )

    const rendered = Array.from(
      container.querySelectorAll('[data-testid="working-status"], [data-testid="activity-group"]'),
    ).map((node) => node.getAttribute('data-testid'))
    expect(rendered).toEqual(['working-status', 'activity-group'])
  })

  it('carries no reasoning text into the DOM, because the part has nowhere to hold any', () => {
    // There is no field on `ReasoningPart` for reasoning text, so the converter has none to pass
    // on — what it hands the library is the platform's own status sentence, because a literally
    // empty reasoning part gets dropped. Not "the renderer chooses not to draw it": there is
    // nothing to draw. The status line is the entire rendered content of the message.
    const { container } = mount([{ id: 'a1', role: 'assistant', parts: [{ type: 'reasoning' }], seq: 1 }], true)

    const message = container.querySelector('[data-testid="assistant-message"]')
    expect(message?.textContent?.trim()).toBe('Working on your app')
  })

  it('shows no status at all once the reasoning part is gone', () => {
    // The surface drops the part the moment the server clears the flag, so the status has to be
    // absent on a turn that carries only prose. Paired with a liveness assertion, because an
    // empty transcript would satisfy the absence for the wrong reason.
    mount([{ id: 'a1', role: 'assistant', parts: [TURN[0]] as MessagePart[], seq: 1 }])

    expect(screen.queryByTestId('working-status')).toBeNull()
    expect(screen.getByTestId('assistant-message').textContent).toContain('Looking at what you already have.')
  })
})
