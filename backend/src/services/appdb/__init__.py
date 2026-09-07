"""Per-project PostgreSQL database provisioning, DSN assembly, and teardown.

The platform owns each project database's LIFECYCLE — create the role, create the database,
raise the cross-app wall, sever it, drop it — and never touches what is inside; Drizzle,
authored by the agent, owns everything past the database boundary.

This `__init__` re-exports only the import-safe half of the package. `src.config` imports
`AppDatabaseSettings` from here, so anything reachable from it must NOT import `src.db.base`
(it builds the engine from `settings` at module scope) — an import cycle would crash startup.
`provision` and `teardown` touch the ORM, so callers import them by module path instead
(`src.services.appdb.provision`, `src.services.appdb.teardown`) — never move them into this file.
"""

from src.services.appdb.config import AppDatabaseSettings as AppDatabaseSettings
from src.services.appdb.engine import aclose_maintenance_engine as aclose_maintenance_engine
from src.services.appdb.engine import get_maintenance_engine as get_maintenance_engine
from src.services.appdb.engine import (
    reset_maintenance_engine_for_tests as reset_maintenance_engine_for_tests,
)
from src.services.appdb.errors import AppDatabaseError as AppDatabaseError
from src.services.appdb.errors import (
    AppDatabaseUnconfiguredError as AppDatabaseUnconfiguredError,
)
from src.services.appdb.names import UnsafeIdentifierError as UnsafeIdentifierError
from src.services.appdb.names import database_name as database_name
from src.services.appdb.names import (
    project_id_from_database_name as project_id_from_database_name,
)
from src.services.appdb.names import project_id_from_role_name as project_id_from_role_name
from src.services.appdb.names import quote_identifier as quote_identifier
from src.services.appdb.names import quote_password_literal as quote_password_literal
from src.services.appdb.names import role_name as role_name
from src.services.appdb.secrets import decrypt_password as decrypt_password
from src.services.appdb.secrets import encrypt_password as encrypt_password
