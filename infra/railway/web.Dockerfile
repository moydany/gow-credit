# syntax=docker/dockerfile:1.7
# Backoffice en Railway (ADR 0068): el mismo build estático que el stage `web` del Dockerfile raíz, que
# Railway no puede elegir porque no deja indicar un `--target`. Nginx reenvía /bo a la API por la red
# privada del proyecto, así la cookie de sesión es del mismo origen.
FROM node:24.17.0-slim AS build
ENV COREPACK_HOME=/corepack
RUN corepack enable && mkdir -p /corepack
WORKDIR /app
COPY . .
RUN corepack install && pnpm install --frozen-lockfile --filter @gow/web... && pnpm -F @gow/web build

FROM nginx:1.28.0-alpine
# La imagen oficial pasa /etc/nginx/templates/*.template por envsubst al arrancar (PORT, API_UPSTREAM).
COPY infra/railway/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
