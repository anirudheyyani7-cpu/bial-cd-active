"""Platform-owned files copied verbatim into every generated app's Docker build context.

A package (not a bare directory) so `importlib.resources` can read them out of the installed
backend image without path arithmetic, and so they travel wherever the backend does.

NOTHING HERE IS PYTHON: the app `Dockerfile`, `.dockerignore`, the strict production migrator,
the Next config wrapper, and a `public/` placeholder — read as bytes, never imported.

Pinned to LF in the root `.gitattributes`: the backend image is built on a Windows VM, and a
CRLF checkout would bake `\\r` into the Dockerfile and migrator, breaking the build for every
citizen at once. `tests/services/deploy/test_assets.py` asserts it."""
