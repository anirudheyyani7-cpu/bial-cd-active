"""Role-scoped application settings.

WHY THIS EXISTS: ONE FILE PER PROCESS — to see what a process needs to boot, read `api.py` or
`worker.py` top to bottom; `core.py` holds only what EVERY process requires, permanently. Import
`settings` from `src.config` (the front door; it picks the profile from `BIAL_ROLE`) — this
package is the declaration.

A field's requirement is spelled by its SHAPE under a section header, never by an
`Optional*`/`Required*` class name — requiredness is a property of the ROLE, not the capability:

    REQUIRED               no default — construction fails in EVERY environment.
    REQUIRED IN PRODUCTION  `X | None = None` + a `_require_<field>_in_production` validator —
                            dev/test boot without it; production refuses and names the variable.
    FEATURE SWITCH          `X | None = None`, no validator — unset means OFF, legitimately, in
                            every environment including production.
    KNOB                    a working default; set only to change behaviour.

`worker.py` REQUIRES `OBJECT_STORE__`/`REDIS__`/`SANDBOX__` (api.py needs them only in
production) — a worker that boots without them can delete the Azure fleet; that is the reason
this per-process split exists.

NAMING: `<Owner>Settings` in `<owner>.py`; a nested env block is `<Service>Config` beside the
service that owns it. `Optional`, `Required`, `Surface`, `Mixin` never appear in a class name.
"""

from src.settings.api import ApiSettings as ApiSettings
from src.settings.core import ROLE_ENV_VAR as ROLE_ENV_VAR
from src.settings.core import SETTINGS_CONFIG as SETTINGS_CONFIG
from src.settings.core import CoreSettings as CoreSettings
from src.settings.foundry import FoundryConfig as FoundryConfig
from src.settings.worker import WorkerSettings as WorkerSettings
