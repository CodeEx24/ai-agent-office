# Production image for the Agent Office worker (AGO-143).
# Build from the repo root:  docker build -f apps/worker/Dockerfile -t ago-worker .
# The base image is pinned by digest; bump it deliberately (node:24-slim).
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @ago/worker...
RUN pnpm --filter @ago/worker... build
# Production-only dependencies plus the built workspace packages, no source or dev tooling.
RUN pnpm --filter @ago/worker --prod deploy --legacy /out

FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production \
    WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.WORKER_PORT+'/health').then(r=>process.exit(r.status===503?1:0),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
