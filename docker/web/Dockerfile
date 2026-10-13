# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Tristan Grunert and contributors
#
# Production web image: a Node stage builds both bundles, and the result is a
# Caddy image carrying nothing but static files. There is no Node at runtime
# (docs/02 §9), which is what keeps the deployment a proxy plus one binary plus
# a database.
#
# Build context is the repository root:
#   docker build -f docker/web/Dockerfile .

ARG NODE_VERSION=24.14.1
ARG CADDY_VERSION=2-alpine
ARG PNPM_VERSION=12.3.4

# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
ARG PNPM_VERSION
ENV CI=true

# Installed before .npmrc is copied, so the repository's engine-strict setting
# cannot fail the bootstrap step itself.
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"

WORKDIR /app

# Manifests first: the dependency layer is then cached across source changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/admin/package.json  apps/admin/package.json
COPY apps/form/package.json   apps/form/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps

# Sequential, not parallel: two Vite builds on one build agent contend for CPU
# and the logs interleave into something nobody can read when it fails.
RUN pnpm --filter "./apps/*" --sequential build

# --------------------------------------------------------------------------
FROM caddy:${CADDY_VERSION} AS runtime

# Caddy's own image runs as root. The compose file grants NET_BIND_SERVICE so
# that dropping to an unprivileged user still leaves :80 and :443 bindable.
RUN addgroup -g 10001 -S evp \
 && adduser  -u 10001 -S -G evp -H -s /sbin/nologin evp \
 && mkdir -p /data /config /srv \
 && chown -R evp:evp /data /config /srv

# Built with base "/"  — served at the root.
COPY --from=build --chown=evp:evp /app/apps/admin/dist /srv/admin
# Built with base "/f/" — Caddy strips the prefix and serves from here.
COPY --from=build --chown=evp:evp /app/apps/form/dist  /srv/form

USER 10001:10001

EXPOSE 80 443

# /etc/caddy/Caddyfile is mounted by compose.prod.yaml and is not baked in:
# the routing belongs to the deployment, not to the frontend build.
