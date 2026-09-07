"""Scheduled task modules.

One module per scheduled job. Each declares its task against the `src.broker` singleton, gates
itself on its own flag — ON by default for a job that already ran unconditionally before it
landed here, OFF for one that never ran unattended — and imports heavy dependencies INSIDE the
task body, so a disabled task costs nothing beyond structlog + the broker + its settings profile.

Every module here MUST be listed in `src/worker_main.py`'s `_TASK_MODULES`: Taskiq only imports
the broker module itself, so an unimported task module is never registered and its messages are
enqueued and silently never consumed. No re-exports: modules are imported for their decoration
side effect, not for names.
"""
