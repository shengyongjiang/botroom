# LAN dashboard in a container. Demo data by default: no host mounts, no
# credentials, nothing privileged. See docs/run.md.
#
# Build context is the working tree (docker compose build), so the committed
# public/office3d.js is rebuilt here from web/office3d.js; uncommitted edits
# to web/ or public/ are picked up too, which is fine for a local run.

# --- build: dependencies + the 3D bundle -----------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# devDependencies (esbuild, three) are needed only here.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY public ./public
RUN npm run build

# --- runtime: no dev dependencies, no toolchain ----------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    WMAD_HOST=0.0.0.0 \
    WMAD_PORT=4546 \
    WMAD_DEMO=1 \
    WMAD_NO_UPDATE_CHECK=1
# Production dependencies only (the app itself has none; keep the layer honest).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY assets ./assets
COPY scenes.json LICENSE ./
# Built 3D bundle from the build stage (overrides the committed copy).
COPY --from=build /app/public/office3d.js ./public/office3d.js
# A writable home is needed for scene installs and ~/.whatsmyagentdoing;
# it is a tmpfs in compose, never a host mount.
# Normalise modes: a stray 0600 in the working tree would lock out USER node.
RUN chmod -R a+rX /app && mkdir -p /home/node/.whatsmyagentdoing && chown -R node:node /home/node/.whatsmyagentdoing
USER node
EXPOSE 4546
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4546/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/cli.js", "--no-open"]
