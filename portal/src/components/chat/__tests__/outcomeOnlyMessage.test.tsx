/**
 * WHAT WITHHOLDING THE NEUTRAL OUTCOME LEAVES BEHIND.
 *
 * `ConversationSurface` used to emit two parts for a finished build: a text part carrying
 * `outcomeSummary(...)` and a `build` part. The text is now withheld when the summary is the
 * neutral "Build finished." — it added nothing under an assistant message that had just described
 * the same build in its own words, and it arrived after EVERY turn in a Build chat.
 *
 * THE RISK THAT CREATES, and the whole reason this file exists: the `build` part draws no element
 * of its own. It is kept because it is what tells the preview pane an app was built here
 * (`transcriptHasBuildOutcome`) and what carries the preview URL. So the message it now travels in
 * alone has nothing visible in it — and an assistant bubble rendered around no content, with a copy
 * button hanging off it that would copy an empty string, is a worse artefact than the redundant
 * sentence that was removed.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

/** Exactly what the live path now produces for a build that simply finished. */
const outcomeOnly: ChatMessage = {
  id: 'b1',
  role: 'assistant',
  parts: [
    {
      type: 'build',
      status: 'ended',
      previewUrl: null,
      endedAt: '2026-09-09T00:00:00.000Z',
      snapshotCommitted: null,
      reason: null,
      turnId: 't1',
    },
  ],
  seq: 1,
  createdAt: '2026-09-09T00:00:00.000Z',
}

/** …and the shape a NAMED ending still produces, which must keep its sentence. */
const stoppedWithText: ChatMessage = {
  id: 'b2',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'You stopped this build before it finished.' },
    {
      type: 'build',
      status: 'stopped',
      previewUrl: null,
      endedAt: '2026-09-09T00:00:00.000Z',
      snapshotCommitted: null,
      reason: 'stopped_by_user',
      turnId: 't2',
    },
  ],
  seq: 2,
  createdAt: '2026-09-09T00:00:00.000Z',
}

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

describe('an outcome-only assistant message', () => {
  it('draws no bubble at all, and no copy button over nothing', () => {
    render(<Harness messages={[outcomeOnly, stoppedWithText]} />)

    // LIVENESS FIRST, and it is doing real work here: the second message proves the thread
    // rendered. Without it, "no bubble" would pass just as happily on a harness that threw before
    // drawing anything — the false-green this repo has shipped before.
    expect(screen.getByText('You stopped this build before it finished.')).toBeTruthy()

    // THE GUARANTEE. Exactly one assistant bubble on screen: the named ending. The outcome-only
    // message contributes none — no empty shell, and no action bar hanging off it whose copy
    // button would put an empty string on the clipboard.
    expect(screen.getAllByTestId('assistant-message')).toHaveLength(1)
    expect(screen.getAllByTestId('assistant-action-bar')).toHaveLength(1)
  })

  it('a NAMED ending keeps its sentence — the narrowing stops exactly where it should', () => {
    render(<Harness messages={[stoppedWithText]} />)
    expect(screen.getByText('You stopped this build before it finished.')).toBeTruthy()
  })
})
