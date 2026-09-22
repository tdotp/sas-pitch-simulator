# Production image for the SAS Pitch Simulator backend.
# Uses `npm install` (not `npm ci`) because this package is part of an npm
# workspaces monorepo — its lockfile lives at the repo root, not here.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Phase 5 (ENGINE vs CONFIG): config packages are plain JSON fixtures read
# at runtime by engine-config/loader.ts (resolved relative to this
# directory, NOT bundled into dist/ — see STORAGE_STRATEGY in
# PHASE_05_ENGINE_CONFIG_REPORT.md). Without this, every /session/start
# would fail with "no config package" in the container despite working
# locally, since node only ever sees what's actually copied into the image.
COPY config-packages ./config-packages
EXPOSE 8080
CMD ["node", "dist/index.js"]
