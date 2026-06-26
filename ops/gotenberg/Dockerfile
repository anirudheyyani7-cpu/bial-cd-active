# Hardened Gotenberg image for .pptx -> PDF deck conversion.
#
# Use this instead of stock `gotenberg/gotenberg:8` when deck FIDELITY matters:
# it pre-installs the metric-compatible substitutes for the common Microsoft
# Office fonts (Carlito <-> Calibri, Caladea <-> Cambria) plus a broad fallback
# set, so LibreOffice doesn't reflow a deck's text when its fonts are absent.
#
# PIN the base tag to a Gotenberg release whose bundled LibreOffice meets the
# security floor (>= 24.8.5 / 25.2.1) for CVE-2024-12425, CVE-2024-12426, and
# CVE-2025-1080 — the bytes we feed it are untrusted user uploads. Check the
# bundled version after building:  docker run --rm <image> libreoffice --version
FROM gotenberg/gotenberg:8

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation \
      fonts-dejavu \
      fonts-noto-core \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
USER gotenberg
