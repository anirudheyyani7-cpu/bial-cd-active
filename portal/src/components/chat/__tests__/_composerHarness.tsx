/**
 * A COMPOSER, UNDER A RUNTIME — the harness every composer suite mounts through.
 *
 * Every library composer primitive resolves against `useAui()`, so `<Composer/>` rendered bare
 * throws for a missing AuiProvider — which is not a testing inconvenience, it is the shape of
 * the thing under test: on both real screens the composer sits inside a provider.
 *
 * The runtime here is the REAL one, not a double: `ChatRuntimeProvider` is what the conversation
 * surface mounts, with the same adapter and capability derivation, so a suite that passes here
 * exercises the composer the citizen gets.
 */
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import ChatRuntimeProvider from '../runtime/ChatRuntimeProvider'

export function ComposerHarness({ children }: { children: ReactNode }) {
  return (
    <ChatRuntimeProvider
      messages={[]}
      isRunning={false}
      onNew={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn().mockResolvedValue(undefined)}
    >
      {children}
    </ChatRuntimeProvider>
  )
}
