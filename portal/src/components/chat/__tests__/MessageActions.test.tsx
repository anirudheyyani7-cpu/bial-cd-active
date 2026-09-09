/**
 * EVERY ASSISTANT MESSAGE CARRIES A COPY ACTION, AND ONLY A COPY ACTION.
 *
 * Own file because of `hideWhenRunning`: `useActionBarFloatStatus` reads `s.thread.isRunning` —
 * the THREAD, not the message — so setting it hides Copy on every assistant message for the whole
 * turn, and a citizen couldn't copy the plan they're reading mid-build. Not set here, deliberately.
 *
 * DELIBERATELY ABSENT: Reload, Edit, feedback, More menu (carries ExportMarkdown), branch picker —
 * each gated by a capability pinned FALSE below. Counting the buttons is what catches one arriving.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { FC } from 'react'

import { Thread, type ThreadComponents } from '../../assistant-ui/thread'
import { convertMessage } from '../runtime/convertMessage'
import type { ChatMessage } from '../../../utils/messageTypes'

afterEach(cleanup)

const TextPart: ThreadComponents['TextPart'] = ({ text }) => <span>{text}</span>
const ToolGroup: ThreadComponents['ToolGroup'] = ({ children }) => <div>{children}</div>
const ToolPart: ThreadComponents['ToolPart'] = () => null

const ReasoningGroup: ThreadComponents['ReasoningGroup'] = () => null

const components: ThreadComponents = { TextPart, ToolGroup, ToolPart, ReasoningGroup }

const reply = (id: string, text: string, seq = 1): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  seq,
  createdAt: '2026-09-01T00:00:00.000Z',
})

const Harness: FC<{ messages: ChatMessage[]; isRunning?: boolean }> = ({ messages, isRunning = false }) => {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    onNew: async () => undefined,
    onCancel: async () => undefined,
    convertMessage,
    unstable_capabilities: { copy: true },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={components} />
    </AssistantRuntimeProvider>
  )
}

const bars = () => screen.queryAllByTestId('assistant-action-bar')

describe('the action bar carries Copy, and only Copy', () => {
  it('renders exactly one button, named "Copy message"', () => {
    render(<Harness messages={[reply('a1', 'Here is the plan.')]} />)
    const buttons = bars()[0]?.querySelectorAll('button') ?? []
    // The COUNT is the assertion. Checking "Copy is present" would keep passing the day a More
    // menu — and the markdown export inside it — arrives beside it.
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Copy message')
  })

  it('offers no Reload, Edit, feedback or branch control', () => {
    render(<Harness messages={[reply('a1', 'Here is the plan.')]} />)
    for (const name of [/regenerate|reload/i, /edit/i, /good response|bad response|feedback/i, /previous|next/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // LIVENESS for those four absences.
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
  })

  it('`hideWhenRunning` is STILL not set — history is never hidden wholesale', () => {
    // Asserted against the SOURCE, because the DOM cannot show it. The library prop reads the
    // THREAD's running state and applies it to EVERY message, so setting it would strip copy off
    // the whole transcript for the duration of a turn — a citizen watching a build could not copy
    // the plan they are reading. The gate this file's other tests exercise is narrower on purpose:
    // the thread is running AND this is the last message.
    //
    // Older replies are hover-revealed by `autohide="not-last"` (its own describe block below), so
    // at rest during a running turn there is no bar in the DOM for EITHER message — which is why
    // "the earlier one keeps its button" is not a jsdom-observable claim and is not asserted as one.
    const source = readFileSync(path.resolve(process.cwd(), 'src/components/assistant-ui/thread.tsx'), 'utf8')
    const actionBar = source.slice(source.indexOf('const AssistantActionBar'))
    expect(actionBar).toContain('autohide="not-last"')
    expect(actionBar.slice(0, actionBar.indexOf('</ActionBarPrimitive.Root>'))).not.toContain('hideWhenRunning')
  })

  it('is withheld from the message being WRITTEN, because copy is how a reply says it is done', () => {
    // The complement, and a real report: a copy button under a half-written reply is the signal
    // every chat product uses to mean "this reply is finished", so it read as the assistant having
    // stopped when it had not. The predicate is both facts together — the thread is running AND
    // this is the last message — which is precisely what `hideWhenRunning` cannot express.
    render(
      <Harness messages={[reply('a1', 'Here is the plan.'), reply('a2', 'Building it now…', 2)]} isRunning />,
    )
    const bubbles = screen.getAllByTestId('assistant-message')
    const streaming = bubbles[bubbles.length - 1]!
    expect(within(streaming).queryByRole('button', { name: 'Copy message' })).toBeNull()
    // Liveness: that message really is on screen, so the absence above is an absence and not a
    // thread that failed to render its last entry.
    expect(streaming.textContent).toContain('Building it now')
  })

  it('comes back on the last message once the turn ends', () => {
    render(<Harness messages={[reply('a1', 'Here is the plan.')]} />)
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
  })
})

describe('the accessible name does not change mid-interaction', () => {
  it('stays "Copy message" after a copy — the ICON swaps, the name does not', async () => {
    // Renaming a control while someone is standing on it is its own defect: a screen-reader user
    // hears the control they just used become a different control. The state change is announced
    // by the polite region instead.
    render(<Harness messages={[reply('a1', 'Here is the plan.')]} />)
    const button = screen.getByRole('button', { name: 'Copy message' })

    fireEvent.click(button)

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Copy message' })).toBe(button)
  })

  it('copies the message’s text', async () => {
    render(<Harness messages={[reply('a1', 'Here is the plan.')]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Here is the plan.'),
    )
  })
})

describe('autohide="not-last"', () => {
  it('the newest reply keeps its bar without a hover', () => {
    // Non-default and deliberate: persistent on the newest reply, hover-revealed on older ones.
    // Hover isn't asserted here — without it the Root returns `null`, so there's no element to
    // query at all.
    render(<Harness messages={[reply('a1', 'older'), reply('a2', 'newest')]} />)
    // One bar, and it belongs to the last message.
    expect(bars()).toHaveLength(1)
    const messages = screen.getAllByTestId('assistant-message')
    expect(messages[messages.length - 1]?.contains(bars()[0] as Node)).toBe(true)
  })
})
