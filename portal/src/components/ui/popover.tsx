import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

/**
 * WHY THIS EXISTS: hand-authored shadcn `new-york` popover, matching the other primitives in
 * this folder (`select.tsx`, `tooltip.tsx`) rather than the current registry. Four things
 * before editing:
 *
 * 1. CLASSES ARE THE OLDER (Tailwind-3) REGISTRY GENERATION — this portal is on Tailwind
 *    3.4.17, and a class the build does not produce renders as nothing while jsdom's DOM
 *    assertions still pass; `tailwind-tokens.test.js` only guards the `bial-*` namespace. Check:
 *    `--popover`, `--popover-foreground`, `--border` are declared in `tailwind.config.js` +
 *    `index.css` (`:root` and `.dark`, confirmed), plus one look in a real browser.
 *
 * 2. PORTALLED IS LOAD-BEARING, not a carried-over default: its one consumer mounts inside four
 *    nested `overflow-hidden` ancestors (`WorkspaceShell` root, row wrapper, pane column,
 *    `AppPaneHost`'s pane). Unportalled content is clipped, not overflowing — it disappears.
 *
 * 3. `@radix-ui/react-popover` IS A DIRECT DEPENDENCY on purpose — it was already on disk as a
 *    transitive of `@assistant-ui/react`, which would silently break on a future install that
 *    reshaped that graph.
 *
 * 4. ALIASES ARE TRIMMED TO THE THREE THE CHIP USES. `PopoverAnchor`/`PopoverClose` were
 *    vendored but reached nothing; they're named here because the unlanded vendoring batch would
 *    re-add them and clobber the custom `align`/`sideOffset` defaults below with no trace of why.
 */

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent }
