FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

# Stage workspace-member package.json files so pnpm-workspace discovery resolves
# every member's dependencies during the install step. Without this, extensions/*
# package.json files arrive later via `COPY . .` and the install above silently
# misses their dependencies (manifesting as runtime `Cannot find module 'postgres'`
# in postgres-using extensions: syntropy, persist-postgres, persist-user-identity,
# memory-graphiti). See monorepo#74 root cause investigation.
COPY extensions ./extensions
COPY packages ./packages

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Plugin cold start: pre-resolve + pre-transpile plugin sources into a jiti cache
# that lives in the image (os.tmpdir() is wiped on every Fly restart). See
# scripts/fly/prepare-plugin-runtime.mjs for the measurements behind this.
ENV OPENCLAW_JITI_CACHE_DIR=/app/.cache/jiti
RUN node scripts/fly/prepare-plugin-runtime.mjs && test -n "$(ls -A /app/.cache/jiti)"

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app
# openclaw-shrineai-identity: the agent identity (agents.defaults.workspace) is image-owned and
# READ-ONLY to the gateway user, so no end user can talk the agent into rewriting its persona.
# It lives under /opt, NOT /app: /app is node-owned, and write access to a parent dir is enough
# to rename a read-only child away and replace it.
RUN mv /app/shrine /opt/shrine && chown -R root:root /opt/shrine && chmod -R a-w,a+rX /opt/shrine

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Fail the build if the identity is missing, ships a first-run BOOTSTRAP.md, or is writable by
# the user the gateway runs as (this check runs AS that user).
RUN test -s /opt/shrine/workspace/SOUL.md && test -s /opt/shrine/workspace/AGENTS.md \
  && test -s /opt/shrine/workspace/USER.md && test -s /opt/shrine/workspace/IDENTITY.md \
  && test ! -e /opt/shrine/workspace/BOOTSTRAP.md \
  && test ! -w /opt && test ! -w /opt/shrine && test ! -w /opt/shrine/workspace \
  && test ! -w /opt/shrine/workspace/SOUL.md && test ! -e /app/shrine

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
