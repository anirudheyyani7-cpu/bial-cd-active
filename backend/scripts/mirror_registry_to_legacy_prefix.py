"""Mirror the environment-scoped sandbox registry back onto the pre-cutover key shape.

The rollback for the registry prefix cutover: a rolled-back image reads only
`bial:sandbox:registry:{user}`, where the records no longer are — `keys.py` records what a
forgotten registry key costs. Copies every `bial:{ENVIRONMENT}:sandbox:registry:*` hash onto the
legacy shape: write-only, idempotent, safe to run before the rollback. `lock`, `heartbeat` and
`lease` are deliberately not mirrored — they re-establish within ninety seconds, and a mirrored
lock can shut somebody out. An existing legacy hash is OVERWRITTEN: the scoped record is newer.

  DRY RUN (default):  uv run python -m scripts.mirror_registry_to_legacy_prefix
  APPLY:              uv run python -m scripts.mirror_registry_to_legacy_prefix --apply
"""

from __future__ import annotations

import argparse
import asyncio
import sys


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually write the legacy keys (default: report what would be written)",
    )
    args = parser.parse_args()

    from src.config import settings
    from src.services.redis import get_redis
    from src.services.redis.keys import (
        FAMILY_REGISTRY,
        KEY_ROOT,
        LEGACY_KEY_PREFIX,
        REGISTRY_FIELD_APP_NAME,
        key_prefix,
    )

    if settings.redis is None:
        print("REFUSING: this deployment has no Redis configured.", file=sys.stderr)
        return 2

    redis = get_redis()
    current_pattern = f"{key_prefix()}{FAMILY_REGISTRY}:*"
    print(f"environment : {settings.ENVIRONMENT}")
    print(f"reading     : {current_pattern}")
    print(f"writing     : {LEGACY_KEY_PREFIX}{FAMILY_REGISTRY}:<user_id>")
    print(f"mode        : {'APPLY' if args.apply else 'dry run'}")
    print("-" * 72)

    mirrored = skipped = 0
    async for raw_key in redis.scan_iter(match=current_pattern):
        key = str(raw_key)
        user_id = key.rsplit(":", 1)[-1]
        # A key we did not write has no business being copied under a prefix the previous image
        # trusts. Cheap sanity rather than a full UUID parse: the shape is ours or it is skipped.
        if not key.startswith(KEY_ROOT) or not user_id:
            skipped += 1
            continue
        record = await redis.hgetall(key)
        if not record:
            skipped += 1
            continue
        legacy = f"{LEGACY_KEY_PREFIX}{FAMILY_REGISTRY}:{user_id}"
        readable = {str(k): str(v) for k, v in record.items()}
        print(f"  {user_id}  ->  {readable.get(REGISTRY_FIELD_APP_NAME, '?')}")
        if args.apply:
            # Inline comprehension, not the `readable` variable above: redis-py types `mapping` as
            # `Mapping[FieldT, EncodableT]` whose KEY parameter is invariant, so a named
            # `dict[str, str]` fails the type gates while the identical inline literal passes.
            # The same workaround `locks._adopt_a_pre_cutover_record` carries, for the same reason.
            await redis.hset(legacy, mapping={str(k): str(v) for k, v in record.items()})
        mirrored += 1

    print("-" * 72)
    print(
        f"{mirrored} record(s) {'mirrored' if args.apply else 'would be mirrored'}"
        f"{f', {skipped} skipped' if skipped else ''}"
    )
    if not args.apply:
        print("\nNothing was written. Re-run with --apply to perform the mirror.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
