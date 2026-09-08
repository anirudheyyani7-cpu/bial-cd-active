import type { FC } from 'react'
import { ArrowDown } from 'lucide-react'
import { useThreadViewport } from '@assistant-ui/react'

export interface ScrollToLatestProps {
  /** A turn is running — the control says a reply is arriving. */
  isRunning: boolean
  /** A pending offer exists and is out of view — the control names it. */
  hasPendingOffer: boolean
}

/** The three things it can say, in the platform's register. */
export function scrollControlLabel(isRunning: boolean, hasPendingOffer: boolean): string {
  if (hasPendingOffer) return 'Back to the plan waiting for you'
  if (isRunning) return 'A reply is arriving — jump to it'
  return 'Jump to the newest message'
}

const ScrollToLatest: FC<ScrollToLatestProps> = ({ isRunning, hasPendingOffer }) => {
  const isAtBottom = useThreadViewport((s) => s.isAtBottom)
  const scrollToBottom = useThreadViewport((s) => s.scrollToBottom)

  // Absent at the bottom rather than disabled, which is why only the viewport hook is used.
  if (isAtBottom) return null

  const label = scrollControlLabel(isRunning, hasPendingOffer)

  return (
    <div className="pointer-events-none flex justify-center pb-2">
      <button
        type="button"
        onClick={() => scrollToBottom({ behavior: 'smooth' })}
        data-testid="scroll-to-latest"
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-bial-border bg-white px-3 py-1.5 text-xs font-semibold text-tertiary shadow-sm transition hover:border-primary hover:text-primary"
      >
        <ArrowDown size={13} aria-hidden="true" />
        {label}
      </button>
    </div>
  )
}

export default ScrollToLatest
