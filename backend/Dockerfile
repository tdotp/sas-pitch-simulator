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
EXPOSE 8080
CMD ["node", "dist/index.js"]
