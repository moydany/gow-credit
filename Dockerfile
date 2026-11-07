# syntax=docker/dockerfile:1.7
# Image for the full-mode processes on Cloud Run (docs/deploy.md). One image per process:
# `--build-arg APP=api` or `--build-arg APP=worker` (also `whatsapp`). The code runs with tsx, as in
# development: there is no build step that could diverge.
FROM node:24.17.0-slim AS deps
ENV COREPACK_HOME=/corepack
# better-sqlite3 (from Evalite) compiles if there is no binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && mkdir -p /corepack && chmod 755 /corepack
WORKDIR /app
COPY . .
RUN corepack install && pnpm install --frozen-lockfile && chmod -R a+rX /corepack

# Static backoffice behind nginx, which forwards /bo to the API so the cookie is same-origin (on
# Vercel the rewrite in apps/web/vercel.json does it). Built with `--target web`.
# Deliberately BEFORE `runtime`: without `--target`, docker builds the last stage, and CI and the
# deploy build the process image without a target.
FROM deps AS web-build
RUN pnpm -F @gow/web build

FROM nginx:1.28.0-alpine AS web
COPY infra/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

FROM deps AS runtime
ARG APP=api
ENV APP=${APP} NODE_ENV=production
# Data directories for the local stack (docker-compose.stack.yml): a named volume inherits the
# owner of the image folder, so `node` can write to it.
RUN mkdir -p /data/storage /data/whatsapp /data/llm-cache && chown -R node:node /data
USER node
EXPOSE 3000
# `APP` can also be changed at start (api, worker, whatsapp): one image serves all three.
CMD ["sh", "-c", "exec ./node_modules/.bin/tsx apps/${APP}/src/main.ts"]
