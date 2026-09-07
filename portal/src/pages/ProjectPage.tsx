/**
 * `/projects/:projectId` — the project screen IS the app now.
 *
 * WHY THIS EXISTS: it shows the RUNNING SANDBOX beside the rail, behind one control the person
 * presses deliberately — nothing starts a container because a screen was opened (the pane reads
 * a cheap state endpoint, no container call). No passive view of stored code, no lifecycle badge,
 * no reroute into a chat; the suite beside this file asserts their absence.
 *
 * This file owns the route, the data, and the beacon — everything visual moved down
 * (`ProjectWorkspace` publishes on the workspace channel, `WorkspaceRail` renders it); it holds
 * no layout of its own, since the two-column frame belongs to `WorkspaceShell`, above the Outlet.
 * THE BEACON FIRES FROM EXACTLY ONE PLACE — the successful-load branch below — because it feeds a
 * measurement nothing in the UI reflects, so a drop or a double-fire makes the numbers wrong with
 * no symptom and no failing test; `observe.ts`'s per-project guard only makes a REPEATED call a
 * no-op, so a second tracker (tempting, since `ProjectWorkspace` independently needs
 * `project.appId`) would bypass that guard rather than be caught by it.
 *
 * Identity model (see: app identity + flat URL model): `appId`/`hasRelaunchableSnapshot` are READ
 * off the project (a backend LEFT JOIN), never via a mutating provision call; `appStatus` lives on
 * the admin registry, not here. A new chat opens at a flat `/chat/{uuid}` carrying its project in
 * a transient `?projectId=&kind=` query — the row doesn't exist until its first message.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import ProjectWorkspace from '../components/workspace/ProjectWorkspace'
import { usePublishHeading, useWorkspaceProject } from '../components/workspace/workspaceChannel'
import { getProject } from '../utils/projectApi'
import type { Project } from '../utils/projectApi'
import { ApiError } from '../utils/apiError'
import { markProjectOpened } from '../utils/observe'

export default function ProjectPage() {
  const { projectId } = useParams()
  // WHICH PROJECT THE WORKSPACE IS SHOWING. Declared above the early returns below, because the
  // loading and load-error branches are still this project's screen. A held preview address
  // outlives the surface that published it, and this is the only thing that can retire a stale one
  // — a surface that says nothing leaves the previous project's app framed, invisibly, with nothing
  // able to notice. `ProjectWorkspace` declares it again once the project resolves; the channel's
  // value comparison makes the second call free.
  useWorkspaceProject(projectId ?? null)
  const navigate = useNavigate()

  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // WHAT THE TOOLBAR ROW NAMES, PUBLISHED FROM THE ROUTE — above the early returns
  // below, for the same reason the project declaration is above them. The loading and load-error
  // branches are still this project's screen, and the row draws its back control and holds its own
  // height on both, rather than appearing once the fetch lands. `chatTitle`/`chatKind` are `null`
  // here and that IS the signal: a heading with no kind is a project screen.
  usePublishHeading({
    projectId: projectId ?? null,
    projectName: project?.name ?? null,
    chatTitle: null,
    chatKind: null,
  })

  const goToProjects = useCallback(() => navigate('/projects', { replace: true }), [navigate])

  // Load the project. A 404 means it was deleted elsewhere — bounce to the index rather than
  // strand the user on a dead page.
  useEffect(() => {
    if (!projectId) {
      goToProjects()
      return
    }
    let active = true
    setLoading(true)
    void (async () => {
      try {
        const loaded = await getProject(projectId)
        if (!active) return
        setProject(loaded)
        setLoadError(null)
        // The chat-open ratio's denominator, and the time-to-app-visible clock's start. Marked
        // HERE rather than on the raw mount because `hasApp` is only knowable once the project
        // has loaded — a project with nothing built has no app to first-see, and starting a
        // clock for it would make this number and the sandbox-first number answer different
        // questions. `markProjectOpened` is idempotent per project id per page load, which is
        // also the StrictMode guard.
        markProjectOpened(loaded.id, { hasApp: loaded.appId !== null })
      } catch (err) {
        if (!active) return
        if (err instanceof ApiError && err.status === 404) {
          goToProjects()
          return
        }
        setLoadError(err instanceof ApiError ? err.message : 'Could not load this project.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [projectId, goToProjects])

  /* THE CHATS READ, ITS ERROR AND THE DELETE HANDLER ARE DELIBERATELY ABSENT. They existed for
     one renderer, the rail's "Conversations · this project" list, which the client asked not to
     have — nothing points back to a chat, running or finished. Removing the list removed the only
     route back to an existing chat AND the only way to delete one; both are the owner's decision,
     taken knowingly. Chats, their plans and their uploaded files stay in the database. Said here
     as well as in the rail because this is where the reads would be, and an absent fetch explains
     itself to nobody. */

  if (loading) {
    return (
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full px-5 py-6">
          <div className="h-6 w-48 bg-gray-100 rounded animate-pulse mb-4" />
          <div className="h-24 bg-gray-100 rounded-2xl animate-pulse" />
        </div>
      </main>
    )
  }

  if (loadError || !project) {
    return (
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full px-5 py-6">
          <button
            onClick={goToProjects}
            className="flex items-center gap-1 text-sm text-neutral hover:text-primary transition mb-4"
          >
            <ArrowLeft size={15} /> Back to projects
          </button>
          <div className="bg-white border border-danger/20 rounded-2xl py-16 px-6 text-center">
            <p className="text-sm font-semibold text-tertiary">Couldn’t load this project</p>
            <p className="text-xs text-neutral mt-1">{loadError || 'It may have been deleted.'}</p>
          </div>
        </div>
      </main>
    )
  }

  return (
    <ProjectWorkspace
      project={project}
      onProjectUpdate={setProject}
    />
  )
}
