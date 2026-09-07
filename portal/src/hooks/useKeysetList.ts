/**
 * Forward-only cursor-list state for a keyset-paginated, searchable endpoint. Keyset
 * gives no total/offset, so pages aren't expressible — the hook holds `items` and
 * appends; the caller adapts its envelope into `KeysetPage` inside `fetchPage` (the
 * admin roster reuses this even though its wire key is `users`, not `items`).
 *
 * Invariants: changing `q` resets the cursor AND clears `items` (a cursor from a
 * different filter is meaningless) — `q` updates immediately, the fetch debounces
 * 300ms. A monotonic request id drops any response that isn't the latest, so a slow
 * `loadMore` can't append after a `setQuery`. `hasMore: false` disables `loadMore`.
 * A failed page sets `error` and stops `loading` without clearing `items`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** The normalized page every `fetchPage` resolves to (the caller maps its own envelope into this). */
export interface KeysetPage<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

/** The args the hook hands `fetchPage`: the server cursor (null on a fresh load), the active query, and the page size. */
export interface KeysetFetchArgs {
  cursor: string | null
  q: string
  limit: number
}

export interface UseKeysetListOptions<T, P extends KeysetPage<T>> {
  fetchPage: (args: KeysetFetchArgs) => Promise<P>
  pageSize?: number
}

export interface UseKeysetListResult<T, P extends KeysetPage<T>> {
  items: T[]
  /** The immediate query value (updates synchronously on `setQuery`; the fetch is debounced). */
  q: string
  /**
   * The query that produced the CURRENT `items`, or `null` before the first fetch
   * has landed. Distinct from `q`, which runs ahead of the data by the debounce
   * window — so an empty-state decision made on `q` will misread "you searched for
   * something with no matches" as "you have nothing at all" for 300ms. Decide what
   * an empty list *means* from this, never from `q`.
   */
  appliedQuery: string | null
  loading: boolean
  hasMore: boolean
  error: Error | null
  /** The full object the most recent successful `fetchPage` resolved with — sibling keys survive. */
  lastPage: P | null
  loadMore: () => void
  setQuery: (next: string) => void
  /** Reload page 1 KEEPING the active query. Use to reconcile after a failed optimistic write. */
  refresh: () => void
  /** Forget everything, including the query. Use when leaving the list, not to reconcile it. */
  reset: () => void
  removeLocal: (predicate: (item: T) => boolean) => void
}

const DEFAULT_PAGE_SIZE = 25
const DEBOUNCE_MS = 300

export function useKeysetList<T, P extends KeysetPage<T> = KeysetPage<T>>(
  options: UseKeysetListOptions<T, P>,
): UseKeysetListResult<T, P> {
  const { fetchPage, pageSize = DEFAULT_PAGE_SIZE } = options

  const [items, setItems] = useState<T[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [lastPage, setLastPage] = useState<P | null>(null)
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null)

  // Refs mirror the pieces that guards and callbacks must read synchronously,
  // without waiting for a re-render.
  const cursorRef = useRef<string | null>(null)
  const qRef = useRef('')
  const reqIdRef = useRef(0)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  // `ReturnType<typeof setTimeout>` (not `number`) so the timer id types the same
  // whether the ambient lib is DOM or a transitively-present `@types/node`.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest-callback ref so `loadMore`/`setQuery` stay stable across renders even
  // when the caller passes a fresh inline `fetchPage` each time.
  const fetchPageRef = useRef(fetchPage)
  fetchPageRef.current = fetchPage

  const runFetch = useCallback(
    async (cursor: string | null, query: string): Promise<void> => {
      const myId = reqIdRef.current + 1
      reqIdRef.current = myId
      loadingRef.current = true
      setLoading(true)
      setError(null)
      try {
        const page = await fetchPageRef.current({ cursor, q: query, limit: pageSize })
        if (reqIdRef.current !== myId) return // a newer request superseded this one — drop it
        cursorRef.current = page.nextCursor
        hasMoreRef.current = page.hasMore
        setHasMore(page.hasMore)
        setLastPage(page)
        setAppliedQuery(query) // the rows below now answer THIS query, not the live input
        // cursor === null is a fresh load (first page or a query change) → replace;
        // a non-null cursor is a forward "load more" → append.
        setItems((prev) => (cursor === null ? page.items : [...prev, ...page.items]))
        loadingRef.current = false
        setLoading(false)
      } catch (caught) {
        if (reqIdRef.current !== myId) return // stale failure — the live request owns the state
        setError(caught instanceof Error ? caught : new Error(String(caught)))
        loadingRef.current = false
        setLoading(false)
      }
    },
    [pageSize],
  )

  const loadMore = useCallback((): void => {
    if (loadingRef.current || !hasMoreRef.current) return
    void runFetch(cursorRef.current, qRef.current)
  }, [runFetch])

  const setQuery = useCallback(
    (next: string): void => {
      qRef.current = next
      setQ(next) // immediate value for the input; only the fetch below is debounced
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        // A new filter invalidates the accumulated cursor and rows outright.
        cursorRef.current = null
        hasMoreRef.current = true
        setHasMore(true)
        setItems([])
        void runFetch(null, qRef.current)
      }, DEBOUNCE_MS)
    },
    [runFetch],
  )

  const refresh = useCallback((): void => {
    // Refetches page 1 under the CURRENT filter (distinct from `reset`, which also clears `q`
    // — a failed-delete reconcile must not throw away what the user is still searching for).
    // Do NOT pre-rewind cursorRef/hasMoreRef: `runFetch(null, …)` replaces on SUCCESS and
    // rewrites both refs from the fresh page, but leaves them untouched on FAILURE. Rewinding
    // here would make a failed refresh's next `loadMore` see `cursor === null` and collapse
    // the list back to page 1 — the success path must stay their sole writer.
    void runFetch(null, qRef.current)
  }, [runFetch])

  const reset = useCallback((): void => {
    reqIdRef.current += 1 // invalidate any in-flight response
    cursorRef.current = null
    qRef.current = ''
    hasMoreRef.current = true
    loadingRef.current = false
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    setItems([])
    setQ('')
    setHasMore(true)
    setError(null)
    setLoading(false)
    setLastPage(null)
    setAppliedQuery(null)
  }, [])

  const removeLocal = useCallback((predicate: (item: T) => boolean): void => {
    setItems((prev) => prev.filter((item) => !predicate(item)))
  }, [])

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    },
    [],
  )

  return { items, q, appliedQuery, loading, hasMore, error, lastPage, loadMore, setQuery, refresh, reset, removeLocal }
}
