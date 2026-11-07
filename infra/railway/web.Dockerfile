# syntax=docker/dockerfile:1.7
# Backoffice on Railway: the same static build as the root Dockerfile's `web` stage, which Railway
# can't pick because it has no `--target`. nginx forwards /bo to the API over the private network.
FROM node:24.17.0-slim AS build
ENV COREPACK_HOME=/corepack
RUN corepack enable && mkdir -p /corepack
WORKDIR /app
COPY . .
RUN corepack install && pnpm install --frozen-lockfile --filter @gow/web... && pnpm -F @gow/web build

FROM nginx:1.28.0-alpine
# The official image runs /etc/nginx/templates/*.template through envsubst at start.
COPY infra/railway/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
