"""Reference `SandboxClient` over LOCAL Docker + an `ObjectStorage` port.

Sandbox-side half of the snapshot/restore — NOT the backend session manager's shipped
orchestration. Subclasses the frozen ABC (all 10 abstract methods, so an incomplete impl
raises `TypeError`) and drives the frozen `/exec` + `/files` surface via baked
`snapshot.sh` / `restore.sh`; base64 is transport only — the stored object is a RAW git bundle.

Scope-honest bound: the `snapshot -> teardown -> release-lock` ordering here uses a MOCK
in-proc lock, not the real Redis lock + ACA teardown (the backend session manager
re-verifies that). A green result proves sandbox mechanics + ABC conformance + REFERENCE
ordering only.
"""

from __future__ import annotations

import asyncio
import base64
import secrets
import time

import httpx
from _docker import Sandbox, run_sandbox
from src.services.sandbox.base import (
    DevLogs,
    DevStatus,
    ExecResult,
    FileCreate,
    FileOp,
    FileResult,
    SandboxClient,
    SandboxError,
    SandboxGoneError,
    SandboxHandle,
    SandboxNotReadyError,
)
from src.services.storage.base import ObjectStorage
from src.services.storage.errors import StorageNotFoundError


class InProcLock:
    """A MOCK in-process one-per-user lock. The reference ordering uses this; the backend
    session manager's real lock is Redis. `is_held` lets the ordering tests assert whether
    release happened."""

    def __init__(self) -> None:
        self._held: set[str] = set()

    def acquire(self, user_id: str) -> None:
        self._held.add(user_id)

    def release(self, user_id: str) -> None:
        self._held.discard(user_id)

    def is_held(self, user_id: str) -> bool:
        return user_id in self._held


def snapshot_key(app_id: str) -> str:
    """The frozen snapshot storage key (owner-scoped by the backend session manager before any
    put/get — not our job)."""
    return f"snapshots/{app_id}/app.bundle"


class ReferenceSandboxClient(SandboxClient):
    SNAPSHOT_SH = "/usr/local/bin/snapshot.sh"
    RESTORE_SH = "/usr/local/bin/restore.sh"
    WORKSPACE = "/workspace/app"
    RESTORE_B64 = ".bial-restore.b64"  # workspace-relative; /files resolves under WORKSPACE

    def __init__(self, *, image: str, storage: ObjectStorage, lock: InProcLock) -> None:
        self._image = image
        self._storage = storage
        self._lock = lock
        self._procs: dict[str, Sandbox] = {}  # fqdn -> live container
        self._by_user: dict[str, SandboxHandle] = {}  # user_id -> latest handle
        self._pids: dict[str, int] = {}  # fqdn -> last dev pid (for the 409 idempotency return)
        self._http = httpx.AsyncClient(timeout=310.0)
        # Ordered step trace for the ordering assertions (snapshot / teardown / release).
        self.trace: list[str] = []

    # --- internal plumbing -------------------------------------------------------------------
    def _sbx(self, handle: SandboxHandle) -> Sandbox:
        sbx = self._procs.get(handle.fqdn)
        if sbx is None:
            raise SandboxGoneError(f"no live container for {handle.fqdn}")
        return sbx

    async def _sup(
        self, handle: SandboxHandle, method: str, path: str, *, json: dict | None = None
    ) -> httpx.Response:
        self._sbx(handle)  # raise SandboxGoneError if the container is gone
        return await self._http.request(
            method,
            f"http://{handle.fqdn}/_sup{path}",
            headers={"Authorization": f"Bearer {handle.token}"},
            json=json,
        )

    # --- ABC: provisioning --------------------------------------------------------------------
    async def provision_new(
        self, user_id: str, app_name: str, *, app_env: dict[str, str]
    ) -> SandboxHandle:
        token = secrets.token_urlsafe(24)
        # app_env carries the three BIAL_* app-data vars — injected as CONTAINER env.
        sbx = await asyncio.to_thread(
            run_sandbox, dict(app_env), image=self._image, token=token, health_timeout=90.0
        )
        fqdn = f"127.0.0.1:{sbx.port}"
        self._procs[fqdn] = sbx
        handle = SandboxHandle(
            fqdn=fqdn,
            token=token,
            app_name=app_name,
            preview_url=f"http://{fqdn}/",
            ready=False,
        )
        self._by_user[user_id] = handle
        return handle

    async def wait_ready(
        self, handle: SandboxHandle, *, timeout_s: float = 120.0
    ) -> SandboxHandle:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            st = await self.dev_status(handle)
            if st.running and st.ready:
                return SandboxHandle(
                    fqdn=handle.fqdn,
                    token=handle.token,
                    app_name=handle.app_name,
                    preview_url=handle.preview_url,
                    ready=True,
                )
            await asyncio.sleep(1.0)
        raise SandboxNotReadyError(f"dev server not ready within {timeout_s}s")

    async def attach_existing(self, user_id: str) -> SandboxHandle:
        handle = self._by_user.get(user_id)
        if handle is None or handle.fqdn not in self._procs:
            raise SandboxGoneError(f"no live sandbox registered for {user_id}")
        try:  # idempotent reconnect — verify the supervisor still answers (else caller restores)
            r = await self._http.get(f"http://{handle.fqdn}/_sup/health", timeout=5.0)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise SandboxGoneError(f"sandbox {handle.fqdn} is unreachable") from e
        return handle

    async def restore_from_snapshot(
        self, user_id: str, app_name: str, *, app_env: dict[str, str]
    ) -> SandboxHandle:
        app_id = app_env["BIAL_APP_ID"]  # parse-don't-validate: a missing id is a programmer error
        # 1. provision a FRESH container WITH the app-data credential re-injected (container env).
        handle = await self.provision_new(user_id, app_name, app_env=app_env)
        # ANY failure below must tear down the fresh container we just provisioned (else it leaks
        # until aclose), then re-raise the real error. A missing snapshot is the ABC's
        # SandboxGoneError path — never a silent empty restore.
        try:
            try:
                raw = await self._storage.get(snapshot_key(app_id))
            except StorageNotFoundError as e:
                raise SandboxGoneError(f"no snapshot at {snapshot_key(app_id)}") from e
            # 2. encode -> /files create -> restore.sh (decode + git fetch/checkout).
            b64 = base64.b64encode(raw).decode("ascii")
            await self.files(handle, FileCreate(path=self.RESTORE_B64, file_text=b64))
            r = await self.run_exec(
                handle,
                [self.RESTORE_SH, self.WORKSPACE, f"{self.WORKSPACE}/{self.RESTORE_B64}"],
                timeout_s=300,
            )
            if r.exit != 0:
                raise SandboxError(f"restore.sh failed: exit={r.exit} stderr={r.stderr[:800]}")
        except Exception:
            await self.teardown(handle)
            raise
        return handle

    # --- ABC: operations ----------------------------------------------------------------------
    async def run_exec(
        self,
        handle: SandboxHandle,
        cmd: list[str],
        *,
        cwd: str | None = None,
        timeout_s: int = 900,
    ) -> ExecResult:
        body: dict[str, object] = {"cmd": cmd, "timeout": timeout_s}
        if cwd is not None:
            body["cwd"] = cwd
        r = await self._sup(handle, "POST", "/exec", json=body)
        if r.status_code == 504:
            raise SandboxError("exec timed out")
        if r.status_code != 200:
            raise SandboxError(f"exec failed: {r.status_code} {r.text[:200]}")
        j = r.json()
        return ExecResult(stdout=j["stdout"], stderr=j["stderr"], exit=j["exit"])

    # The frozen abstract method is named `exec`; `run_exec` above holds the body (a bare
    # `def exec` trips an over-eager JS-oriented lint), and this alias satisfies the ABC.
    exec = run_exec

    async def files(self, handle: SandboxHandle, op: FileOp) -> FileResult:
        r = await self._sup(handle, "POST", "/files", json=op.model_dump())
        if r.status_code != 200:
            raise SandboxError(f"files {op.action} failed: {r.status_code} {r.text[:200]}")
        j = r.json()
        ok = bool(j.pop("ok", True))
        return FileResult(ok=ok, detail=j)

    async def dev_start(
        self, handle: SandboxHandle, *, cmd: list[str] | None = None, cwd: str | None = None
    ) -> int:
        body: dict[str, object] = {}
        if cmd is not None:
            body["cmd"] = cmd
        if cwd is not None:
            body["cwd"] = cwd
        r = await self._sup(handle, "POST", "/dev/start", json=body)
        if r.status_code == 409:  # idempotent: already running -> return the last known pid
            return self._pids.get(handle.fqdn, -1)
        if r.status_code != 200:
            raise SandboxError(f"dev_start failed: {r.status_code} {r.text[:200]}")
        pid = int(r.json()["pid"])
        self._pids[handle.fqdn] = pid
        return pid

    async def dev_status(self, handle: SandboxHandle) -> DevStatus:
        r = await self._sup(handle, "GET", "/dev/status")
        if r.status_code != 200:
            raise SandboxError(f"dev_status failed: {r.status_code}")
        j = r.json()
        return DevStatus(running=j["running"], ready=j["ready"], port=j["port"])

    async def dev_logs(self, handle: SandboxHandle, *, since: int = 0) -> DevLogs:
        r = await self._sup(handle, "GET", f"/dev/logs?since={since}")
        if r.status_code != 200:
            raise SandboxError(f"dev_logs failed: {r.status_code}")
        j = r.json()
        return DevLogs(lines=j["lines"], next_cursor=j["next"])

    async def teardown(self, handle: SandboxHandle) -> None:
        sbx = self._procs.pop(handle.fqdn, None)
        self._pids.pop(handle.fqdn, None)
        if sbx is not None:  # idempotent: already gone is a no-op
            await asyncio.to_thread(sbx.stop)

    # --- snapshot orchestration (NOT part of the ABC — a reference artifact) ------------------
    async def snapshot(self, handle: SandboxHandle, *, app_id: str) -> None:
        """Step 1: snapshot.sh via /exec -> DECODE base64 stdout -> storage.put(RAW bundle)."""
        r = await self.run_exec(handle, [self.SNAPSHOT_SH, self.WORKSPACE], timeout_s=300)
        if r.exit != 0:
            raise SandboxError(f"snapshot.sh failed: exit={r.exit} stderr={r.stderr[:800]}")
        raw = base64.b64decode(r.stdout)  # the STORED object is a raw git bundle, not base64
        await self._storage.put(snapshot_key(app_id), raw, content_type="application/x-git-bundle")

    async def checkpoint_and_teardown(
        self, handle: SandboxHandle, *, app_id: str, user_id: str
    ) -> None:
        """The idle-teardown ordering: snapshot -> teardown -> release-lock, STRICT. A snapshot
        failure raises here and aborts BEFORE teardown; the lock is NOT released (abort-before-
        teardown — the lock is what makes snapshot->teardown atomic from the user's view)."""
        self.trace.append("snapshot")
        await self.snapshot(handle, app_id=app_id)  # raises on failure -> nothing below runs
        self.trace.append("teardown")
        await self.teardown(handle)
        self.trace.append("release")
        self._lock.release(user_id)

    async def aclose(self) -> None:
        """Tear down every tracked container + the HTTP client. Harness only, not an ABC
        method."""
        await self._http.aclose()
        for sbx in list(self._procs.values()):
            await asyncio.to_thread(sbx.stop)
        self._procs.clear()
