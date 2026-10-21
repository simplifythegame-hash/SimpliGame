# SimpliGame — production image (own-box deployment).
#
# Multi-stage: the build stage compiles client + server exactly the
# way Render does today (install incl. dev deps, then the root
# `npm run build` across both workspaces); the runtime stage runs
# ONLY the server, which also serves the built client in production
# (NODE_ENV=production) — the same single-process shape as the
# Render web service, so the box runs what production runs.
# Database + storage are separate compose services (docker-compose.yml);
# this image is just the app.

FROM node:20-slim AS build
WORKDIR /app
# Manifests first (layer caching): root + both workspaces.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci --include=dev
COPY client ./client
COPY server ./server
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
EXPOSE 4000
# PORT comes from the environment (compose sets 4000); the server
# defaults to 4000 when PORT is unset.
CMD ["node", "server/dist/index.js"]
