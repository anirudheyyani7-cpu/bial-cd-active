import { useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Drops the transient `?projectId=&kind=` query once a chat's row exists, rewriting to
 * the flat `/chat/{id}`, and drops router `state` with it — both are the same one-shot,
 * mount-time hand-off. Guarded once per chat id (the send path calls this every turn) and
 * only while that chat is still on screen, since this runs after an await and a stale
 * `navigate()` could snap the user back to a chat they left. Carrying `state` forward is
 * not harmless (N1): it can survive a reload and re-fire the opening prompt, billing it twice.
 */
export function useDropTransientQuery(): (chatId: string) => void {
  const navigate = useNavigate()
  const location = useLocation()
  const cleanedRef = useRef<string | null>(null)

  // The latest location, readable from inside a stale closure.
  const locationRef = useRef(location)
  locationRef.current = location

  return useCallback(
    (chatId: string) => {
      const current = locationRef.current
      if (cleanedRef.current === chatId || !current.search) return
      // The user navigated away while the append was in flight. Their URL is not ours to rewrite.
      if (current.pathname !== `/chat/${chatId}`) return
      cleanedRef.current = chatId
      navigate(`/chat/${chatId}`, { replace: true, state: null })
    },
    [navigate],
  )
}
