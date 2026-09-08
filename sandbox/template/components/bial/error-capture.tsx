"use client";

/**
 * BialErrorCapture — publishes the injected runtime identity to `window.__BIAL_CONFIG` (see
 * lib/bial-config.ts) and relays uncaught client errors to the framing parent.
 *
 * Imported FIRST in app/layout.tsx, above the app tree. The config global is set during the
 * RENDER phase, not an effect, so it is in place before any child effect runs — React commits
 * effects child-first but renders parent-first. Only non-secret labels travel this way; the
 * app's own data stays server-side, so the browser never holds a data credential.
 *
 * Errors relay via postMessage with an EXPLICIT targetOrigin (the portal origin, never `'*'`); if
 * none is known it does not post at all. The platform consumes this relay — it is not dead code.
 */

import { useEffect } from "react";
import type { BialConfig } from "@/lib/bial-config";

type ClientError = {
  type: "bial:client-error";
  source: "window.onerror" | "unhandledrejection" | "console.error" | "console.warn";
  title: string;
  stack: string;
  ts: number;
};

function resolvePortalOrigin(): string | null {
  const injected = typeof window !== "undefined" ? window.__BIAL_CONFIG?.portalOrigin : undefined;
  if (injected) return injected;
  // Fall back to the framing parent's origin (the portal) when config has not landed yet.
  if (typeof document !== "undefined" && document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

function relay(payload: Omit<ClientError, "type" | "ts">): void {
  if (typeof window === "undefined" || window.parent === window) return; // not framed → no relay target
  const targetOrigin = resolvePortalOrigin();
  if (!targetOrigin) return; // fail closed — never post to '*'
  const message: ClientError = { type: "bial:client-error", ts: Date.now(), ...payload };
  // One-way by contract: the parent never answers, so nothing here waits for a reply.
  window.parent.postMessage(message, targetOrigin);
}

export function BialErrorCapture({ config }: { config: BialConfig }) {
  // Render-phase, idempotent global publish — see the header note on effect ordering.
  if (typeof window !== "undefined" && !window.__BIAL_CONFIG) {
    window.__BIAL_CONFIG = config;
  }

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      relay({
        source: "window.onerror",
        title: e.message || "Uncaught error",
        stack: e.error instanceof Error ? (e.error.stack ?? "") : String(e.error ?? ""),
      });
    };

    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      relay({
        source: "unhandledrejection",
        title: reason instanceof Error ? reason.message : "Unhandled promise rejection",
        stack: reason instanceof Error ? (reason.stack ?? "") : String(reason ?? ""),
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => {
      relay({ source: "console.error", title: args.map(String).join(" ").slice(0, 500), stack: "" });
      origError.apply(console, args);
    };
    console.warn = (...args: unknown[]) => {
      relay({ source: "console.warn", title: args.map(String).join(" ").slice(0, 500), stack: "" });
      origWarn.apply(console, args);
    };

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = origError;
      console.warn = origWarn;
    };
  }, []);

  return null;
}
