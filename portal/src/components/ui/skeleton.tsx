import { cn } from "@/lib/utils"

/**
 * A pulsing placeholder block. DECORATIVE, hence `aria-hidden`: it carries no text, so a reader
 * gets an unlabelled group of empty boxes out of it, and the wait it belongs to already states
 * itself in words inside a polite region its caller owns (`ProjectsPage`) — leaving these in the
 * tree beside that sentence is one wait said twice, once in words and once as a shape. That
 * sentence has to exist because `index.css` suppresses the pulse under `prefers-reduced-motion`,
 * leaving a citizen who asked for less motion a still grey rectangle and no explanation.
 * `aria-busy` belongs on the waiting CONTAINER, not each block, and lives at the call sites;
 * `aria-hidden` is written before the spread so a labelled caller can still override it.
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
