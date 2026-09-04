/**
 * THE RAIL — one white column: start a chat, app status, description, hairlines between.
 *
 * It fills the shell's `<Outlet/>` column and must not draw the app pane as well: an iframe built
 * in here sits inside the content a route change replaces, so it remounts and reloads the running
 * app on the first navigation to a chat. The shell holds the pane as a sibling of the Outlet, and
 * a rail-plus-pane layout nested in here is how that gets undone.
 */
import ProjectDescriptionEditor from '../projects/ProjectDescriptionEditor'
import RailComposer from './RailComposer'
import AppStatusPanel from './AppStatusPanel'
import type { Project } from '../../utils/projectApi'
import type { SaveState } from '../../utils/buildSessionApi'

export interface WorkspaceRailProps {
  project: Project
  /**
   * Null while the workspace is stopped. Reading the save state runs `git` inside the container,
   * so asking it of a stopped project would start one — a start the screen caused rather than the
   * citizen.
   */
  save: SaveState | null
  onProjectUpdate: (project: Project) => void
}

/** The board's section label: 10.5px, weight 700, .7px tracking. Its colour is per-section. */
function SectionLabel({ children, className = 'text-neutral' }: { children: string; className?: string }) {
  return <h2 className={`text-[10.5px] font-bold tracking-[.7px] ${className}`}>{children}</h2>
}

export default function WorkspaceRail({ project, save, onProjectUpdate }: WorkspaceRailProps) {
  return (
    // `min-h-0` is what actually lets this flex child scroll: without it the child's min-content
    // height wins and the overflow never has anywhere to happen. The column is what lets the
    // description sit at the foot on a tall screen and scroll normally on a short one.
    <main className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-white">
      <section className="px-[18px] pb-[15px] pt-4">
        <SectionLabel className="text-primary-900">START A CHAT</SectionLabel>
        <RailComposer projectId={project.id} />
      </section>

      <div className="h-px flex-shrink-0 bg-bial-border" />

      <section data-testid="rail-app-status" className="px-[18px] py-[15px]">
        {/* THE LABEL GOES DOWN INTO THE PANEL rather than being drawn above it, because the boards
            put it and the state pill on ONE row. The treatment is still this file's — the panel
            receives the rendered label, it does not write one. */}
        <AppStatusPanel projectId={project.id} label={<SectionLabel>APP STATUS</SectionLabel>} />
        {/* A DIFFERENT QUESTION FROM THE PANEL'S SAVED ROW, which reports the version the citizen
            last saved: this is whether the LIVE container has moved on since. `dirty` is TRI-STATE
            and its `null` is "could not tell" — collapsing it to a boolean turns a failed check
            into a confident "everything is saved". */}
        {save && (
          <div data-testid="rail-save-state" className="mt-3 border-t border-bial-border pt-3">
            <p className="text-[11.5px] text-neutral">
              {save.dirty === true
                ? 'You have changes that are not saved yet.'
                : save.dirty === false
                  ? 'Everything is saved.'
                  : 'We could not check for unsaved changes.'}
            </p>
          </div>
        )}
      </section>

      <div className="min-h-0 flex-1" />

      <div className="h-px flex-shrink-0 bg-bial-border" />

      {/* THE TESTID IS KEPT DELIBERATELY. This is no longer a bordered card, but it is the same
          description block with the same read-view-plus-Edit-pop-up behaviour, and renaming the
          handle would retire the assertions that still hold as collateral of a layout change. */}
      <section data-testid="description-rail" className="px-[18px] pb-4 pt-3.5">
        <ProjectDescriptionEditor
          projectId={project.id}
          description={project.description}
          onProjectUpdate={onProjectUpdate}
        />
      </section>
    </main>
  )
}
