import { cn } from "@/lib/utils"

/**
 * A pulsing placeholder block. DECORATIVE, and now says so (`#210`).
 *
 * Two reasons for `aria-hidden`. The block carries no text, so a reader gets an unlabelled group
 * of empty boxes out of it and learns nothing — and since `#210` the wait it belongs to states
 * itself in words, inside a polite region its caller owns (`ProjectsPage`). Leaving these in the
 * accessibility tree beside that sentence is the wait described twice, once in words and once as
 * a shape.
 *
 * The pulse itself is suppressed under `prefers-reduced-motion` by `index.css`, which is exactly
 * why the sentence had to exist: without it a citizen who asks for less motion gets a still grey
 * rectangle and no explanation. `aria-busy` belongs on the CONTAINER that is waiting, not on each
 * block, and lives at the call sites.
 *
 * `aria-hidden` is written before the spread so a caller that has a labelled use for one of these
 * can still override it.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      aria-hidden="true"
      {...props}
    />
  )
}

export { Skeleton }
