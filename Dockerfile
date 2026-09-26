# syntax=docker/dockerfile:1.7
# Build stages run on the build machine's native architecture (BUILDPLATFORM)
# and produce platform-independent artifacts; only the runtime layer is built
# per target platform. This keeps linux/386 builds as cheap as amd64/arm64.
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY frontend/ ./
RUN npm run build

# Produces dist/ (pure JS) plus a full node_modules used by the asset
# extraction stage below. This node_modules is NOT copied into the runtime
# image: native binaries (napi) must match the target platform, which is
# installed there per-arch instead.
FROM --platform=$BUILDPLATFORM node:24-alpine AS backend-build
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY backend/ ./
RUN npm run build

# Downloads the public Apple update package once (~380 MB over range
# requests), verifies the pinned digests, strips fat binaries to their x86_64
# slices, and emits ~22.5 MB of assets. Docker layer caching makes this a
# no-op on rebuilds unless the pinned digests change.
FROM --platform=$BUILDPLATFORM node:24-alpine AS sap-assets
WORKDIR /app/backend
COPY --from=backend-build /app/backend ./
ARG SAP_ASSETS_OUT=/out
RUN DATA_DIR=/tmp/sap-extract-work node --import tsx scripts/extract-sap-assets.mts ${SAP_ASSETS_OUT}

# The macOS package decrypter. Apple serves a macOS download as a
# FairPlay-encrypted package — not a xar archive at all until Apple's own
# StoreAgent has decrypted it — and the emulation that drives StoreAgent lives
# in ipatool's internal packages. tools/macdecrypt is its own module whose path
# sits under github.com/majd/ipatool/v2/, which is what lets it import them;
# the dependency (MIT, Copyright (c) 2021 Majd Alfhaily) arrives from the
# module proxy at the version pinned in go.mod, so there is nothing to clone.
# CGO is off: ipatool loads the Unicorn runtime with purego at run time.
#
# This stage builds natively per target platform, and not because a cross
# build would be slow. purego forces a dynamically linked ELF even with
# CGO off, so the interpreter recorded in the binary is whatever the builder's
# linker writes: an Alpine builder records its own musl loader, which the
# runtime image — also Alpine — has. A cross-compiled internal link instead
# records the glibc loader (e.g. /lib/ld-linux-aarch64.so.1 on linux/arm64),
# which no Alpine container has, and exec of the helper then fails with ENOENT
# even though the file is there. That is why the FROM carries no
# --platform=$BUILDPLATFORM and no GOARCH is set: the Go toolchain must run
# on the architecture the image is being built for.
FROM golang:1.26-alpine AS macdecrypt
WORKDIR /src
COPY tools/macdecrypt/go.mod tools/macdecrypt/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY tools/macdecrypt/*.go ./
RUN --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/macdecrypt .
# Prove the artifact is executable in an Alpine userland of its own arch
# before anything copies it: a missing interpreter or a wrong-arch binary
# surfaces here, not in a download task on some other machine.
RUN sh -c 'out="$(/out/macdecrypt 2>&1 || true)"; case "$out" in \
    *"No such file"*|*"not found"*|*"Exec format"*) \
        echo "built helper is not runnable: $out"; exit 1;; \
    *) echo "helper runs on $(uname -m)" ;; esac'

FROM node:24-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY backend/package*.json ./
# Native modules install per target platform. @node-rs/crc32 (via
# yauzl-promise) ships prebuilt napi binaries as optionalDependencies
# (e.g. @node-rs/crc32-linux-arm64-musl) — npm installs the right slice
# automatically. bufferutil (via wisp-js) has no linux-arm64-musl prebuild
# and falls back to source compilation, which triggers SIGILL under QEMU
# cross-builds. --ignore-scripts skips both the bufferutil compile and
# the @node-rs/crc32 verification require(); the binaries are already in
# place from the optionalDependencies install. bufferutil is optional
# for ws and falls back to pure JavaScript. No compiler toolchain is
# needed at runtime because --ignore-scripts skips every postinstall.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts
# NOTE: no `npm cache clean` here — the /root/.npm cache mount is shared by
# every stage (same cache id) and never enters an image layer, so cleaning it
# saves nothing while racing another stage's concurrent npm ci (ENOTEMPTY).
COPY --from=frontend-build /app/frontend/dist ./public
COPY --from=sap-assets /out /opt/asspp/sap-assets
# Apple serves a macOS package encrypted, and this is what opens it. It fetches
# its own copy of Apple's assets and the Unicorn runtime on first use; with
# DATA_DIR on a volume that only happens once per deployment (see macDecrypt.ts,
# which points XDG_CACHE_HOME at <DATA_DIR>/cache).
# `services/macDecrypt.ts` looks the helper up at this exact path.
COPY --from=macdecrypt /out/macdecrypt /opt/asspp/macdecrypt
RUN mkdir -p /data/packages
EXPOSE 8080
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown

ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE
# Run as a release build: Express drops its development behaviours (verbose
# error output, per-request view lookups) and libraries stop assuming a dev
# tree. The image ships production dependencies only, so nothing here depends
# on dev mode.
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
