// ============================================================================================
// PLATFORM-OWNED FILE. DO NOT MODIFY, RENAME, OR DELETE THIS FILE.
//
// If you are an AI agent building an app in this workspace: this file is not yours, exactly as
// `next.config.ts` is not. Read it if you like; never edit it, never delete it, never replace it,
// never import it, and never post the messages it posts from your own code. Nothing you are asked
// to build needs a change here.
//
// WHAT IT DOES
//
// Next.js loads `instrumentation-client.ts` on every page load, before any of the app's own client
// code runs (a framework convention — no import, no registration). This copy answers ONE question
// for the BIAL portal that frames your app: "is a document of this app showing something in the
// person's browser right now?" It posts `bial:app-mounted` to the framing portal once the page
// has something on it, and answers the portal's `bial:ping` with either that message or
// `bial:app-painting` ("alive, nothing to show yet"). The portal reveals the preview pane ONLY on
// `bial:app-mounted`. Without it, the person looking at your app sees a waiting card, however
// healthy every server-side check says the app is.
//
// WHAT THE MESSAGES CLAIM, EXACTLY. `bial:app-mounted`: this file executed in the framed document
// — so the document is this app's, since a bodyless 502 from the ingress ships no script at all —
// and it found something a person can see: text or a visual element inside the viewport, with a
// real box, not hidden, not transparent. Not the framework's own 404 page, which is a page with
// words on it and is never the app. `bial:app-painting`: this file executed and found nothing to
// show yet. Neither proves the app works: a page whose code fails after it painted has still been
// seen, and the platform's other signals cover that. This file depends on nothing else in this
// workspace — not the layout, not the config shim, not a type declaration — and prefers the
// browser's own record of who framed it over anything an app file could publish, so no edit to an
// app file silences it.
//
// WHY IT EXISTS
//
// Every other signal the platform has is measured on the wrong side of the network. The container
// proves the app answers on its own loopback; the person reaches it through a gateway and an
// ingress, where a 502 with an empty body loads in the frame exactly like a page does. Only the
// document itself can say it is showing — so it says so from here. The file rides the sandbox
// image and is kept out of every workspace snapshot by the image's own git exclude
// (`sandbox/platform-owned.gitignore`), so a restore never overlays it and a platform fix always
// reaches the next launch.
//
// SECURITY
//
// A ping is honoured only when it came from the framing window AND from an origin this document
// can account for — the browser's own `ancestorOrigins` record where the engine has it (every
// browser BIAL uses), else the portal origin the platform injected (`BIAL_PORTAL_ORIGIN`,
// published to `window.__BIAL_CONFIG` by the layout's shim when present), else the referrer — and
// the answer goes back to the ping's own origin, never `'*'`. The spontaneous post targets the
// same first-available origin. Messages carry their type and this document's path, nothing else;
// the portal checks the path against the address it framed, so a frame that navigated itself to a
// different app is not revealed as this one. When the app is not framed at all, this file does
// nothing. Known limit: Firefox has no `ancestorOrigins`, and there the spontaneous post after an
// in-frame navigation can mis-target (the referrer is the previous document) — the portal's ping,
// answered to its own proven origin, is what carries that case.
// ============================================================================================

const MOUNTED_TYPE = "bial:app-mounted";
const PAINTING_TYPE = "bial:app-painting";
const PING_TYPE = "bial:ping";

// The slow backstop behind the DOM observer, and the budget for the spontaneous post. A cold first
// route compile has been measured at 5-7s with a slow hydration behind it, so the budget is long;
// past it, only an unanswered ping keeps the check alive, and every later ping is answered from
// the live check regardless.
const PAINT_CHECK_BACKSTOP_MS = 1_000;
const PAINT_WAIT_MS = 60_000;
// How many text nodes the visibility walk will inspect before giving up on a page: a bound on
// cost, not on correctness — a page with that much hidden text ahead of its first visible word
// is answered by the next check, not by a stalled one.
const TEXT_NODE_BUDGET = 500;

/** The portal origin the layout's shim published, if that shim is present and said something.
 *  Read by narrowing rather than through a shared type, so this file compiles with no other file. */
function publishedPortalOrigin(): string | null {
  const w: unknown = window;
  if (typeof w !== "object" || w === null || !("__BIAL_CONFIG" in w)) return null;
  const config: unknown = w.__BIAL_CONFIG;
  if (typeof config !== "object" || config === null || !("portalOrigin" in config)) return null;
  const origin: unknown = config.portalOrigin;
  return typeof origin === "string" && origin !== "" ? origin : null;
}

/** Every origin this document can account for as its framer, best evidence first. */
function candidateOrigins(): string[] {
  const found: string[] = [];
  // The browser's own record of who is framing this document. App code cannot write it, and it
  // is not the previous document, which is what `document.referrer` becomes after any navigation
  // inside the frame.
  const ancestors = window.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) found.push(ancestors[0]);
  const published = publishedPortalOrigin();
  if (published && !found.includes(published)) found.push(published);
  if (document.referrer) {
    try {
      const referrer = new URL(document.referrer).origin;
      if (!found.includes(referrer)) found.push(referrer);
    } catch {
      // An unparsable referrer is no evidence at all.
    }
  }
  return found;
}

/** Does this element put pixels a person can see inside the viewport? A real box — wider and
 *  taller than the one-pixel boxes the screen-reader-only idiom and tracking pixels use — that is
 *  not hidden and not transparent AT ANY LEVEL (a fade-in wrapper at `opacity:0` hides everything
 *  under it), and overlaps the viewport. `display:none` yields no box at all. Text painted in a
 *  transparent colour is the one idiom this cannot see through, and it is accepted. */
function isVisibleBox(el: Element): boolean {
  for (let node: Element | null = el; node !== null && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.opacity === "0" || style.display === "none") return false;
  }
  for (const rect of el.getClientRects()) {
    if (
      rect.width > 1 &&
      rect.height > 1 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    ) {
      return true;
    }
  }
  return false;
}

/** The framework's own not-found page — a page with words on it that is never the app. Next
 *  renders it with a title beginning "404" and an `.next-error-h1` heading. */
function isFrameworkNotFound(): boolean {
  return document.querySelector(".next-error-h1") !== null || /^404\b/.test(document.title);
}

/** Is there anything on this page for a person to see? Visible text (a text node whose element
 *  paints a real box in the viewport), or a visual element that does. The SSR markup counts — it is
 *  what the person sees — and an empty body, a body of hidden text, and a body of zero-size
 *  elements are all the blank the portal must never reveal. */
function documentShowsSomething(): boolean {
  const body = document.body;
  if (!body) return false;
  if (isFrameworkNotFound()) return false;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let inspected = 0;
  for (let node = walker.nextNode(); node !== null && inspected < TEXT_NODE_BUDGET; node = walker.nextNode()) {
    inspected += 1;
    if ((node.textContent ?? "").trim() === "") continue;
    const el = node.parentElement;
    if (el && isVisibleBox(el)) return true;
  }
  for (const el of body.querySelectorAll("img, svg, canvas, video, iframe")) {
    if (isVisibleBox(el)) return true;
  }
  return false;
}

function post(type: string, target: string): void {
  window.parent.postMessage({ type, path: window.location.pathname }, target);
}

if (typeof window !== "undefined" && window.parent !== window) {
  let posted = false;
  let observer: MutationObserver | null = null;
  let backstop: number | null = null;
  let checkQueued = false;
  let pingPending = false;
  const startedAt = Date.now();

  const stopLooking = (): void => {
    observer?.disconnect();
    observer = null;
    if (backstop !== null) window.clearInterval(backstop);
    backstop = null;
  };

  // The spontaneous post: once, to the best origin available, the moment the page shows
  // something. Checked when the DOM changes (one check per animation frame, however many
  // mutations arrive) and on a slow backstop — never on a tight poll, because measuring boxes
  // forces layout and a 50ms loop would slow the very paint it is waiting for.
  const checkNow = (): void => {
    checkQueued = false;
    if (posted) return;
    if (documentShowsSomething()) {
      posted = true;
      pingPending = false;
      stopLooking();
      const target = candidateOrigins()[0];
      if (target) post(MOUNTED_TYPE, target); // fail closed — never post to '*'
      return;
    }
    if (Date.now() - startedAt >= PAINT_WAIT_MS && !pingPending) stopLooking();
  };
  const queueCheck = (): void => {
    if (checkQueued || posted) return;
    checkQueued = true;
    window.requestAnimationFrame(checkNow);
  };
  const keepLooking = (): void => {
    if (posted) return;
    if (observer === null) {
      observer = new MutationObserver(queueCheck);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    if (backstop === null) backstop = window.setInterval(queueCheck, PAINT_CHECK_BACKSTOP_MS);
  };

  // The portal pings on every `load` of its frame, while it waits, and as a slow heartbeat once
  // it has revealed, because a document can be replaced from the inside (a dev-server restart
  // reloads the page) or go blank after it painted (a client-side route to nothing) without the
  // portal seeing more than a `load`, or nothing at all. Answered from the LIVE check, never from
  // a latch, and to the ping's OWN origin — which the browser has already proven — so the answer
  // cannot mis-target. A page with nothing to show says so ("painting"), which tells the portal
  // it is alive and must be asked again rather than fetched again; the debt of that ping is
  // honoured the moment the page shows something.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (!candidateOrigins().includes(event.origin)) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null || !("type" in data) || data.type !== PING_TYPE) return;
    if (documentShowsSomething()) {
      post(MOUNTED_TYPE, event.origin);
      return;
    }
    // Nothing to show right now — and if something HAD been shown before, the page has gone
    // blank since, so the spontaneous post is re-armed: the next paint is news again.
    post(PAINTING_TYPE, event.origin);
    posted = false;
    pingPending = true;
    keepLooking();
  });

  keepLooking();
  checkNow();
}

// A module, not a global script: none of the names above may leak into the app's own scope.
export {};
