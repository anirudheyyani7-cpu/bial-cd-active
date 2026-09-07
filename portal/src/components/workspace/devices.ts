/**
 * THE THREE WIDTHS THE PANE CAN FRAME AT, and their one home. Read by `WorkspaceToolbar`
 * (the switcher) and the device card the pane draws, so both ends read one table rather than
 * two that could disagree about what "Tablet" means.
 *
 * ITS OWN LEAF MODULE: importing this table from the component that owns the switcher would
 * close a five-module ring (`LivePreview` → `WorkspaceToolbar` → `WorkspaceShell` → `AppPane`
 * → `AppPaneHost` → `LivePreview`). Module evaluation order is not something Vitest and the
 * production Rollup build are obligated to agree about, and the next top-level `const` added
 * anywhere in that ring turns it into a "cannot access before initialization" at boot. A leaf
 * nothing imports back cannot.
 */
import { Monitor, Smartphone, Tablet, type LucideIcon } from 'lucide-react'

export const DEVICES = {
  Desktop: { icon: Monitor as LucideIcon, width: null as number | null },
  Tablet: { icon: Tablet as LucideIcon, width: 834 }, // iPad Pro 11" portrait — Chrome DevTools preset
  Mobile: { icon: Smartphone as LucideIcon, width: 390 }, // iPhone 12/13/14-class width
}

export type DeviceName = keyof typeof DEVICES
