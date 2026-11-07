# syntax=docker/dockerfile:1.7
# Imagen de los procesos del modo full para Cloud Run (docs/deploy.md). Una sola imagen por
# proceso: `--build-arg APP=api` o `--build-arg APP=worker` (también `whatsapp`).
# El código corre con tsx, como en desarrollo: no hay paso de compilación que pueda divergir.
FROM node:24.17.0-slim AS deps
ENV COREPACK_HOME=/corepack
# better-sqlite3 (de Evalite) compila si no hay binario para la plataforma.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && mkdir -p /corepack && chmod 755 /corepack
WORKDIR /app
COPY . .
RUN corepack install && pnpm install --frozen-lockfile && chmod -R a+rX /corepack

# Backoffice estático detrás de nginx, que reenvía /bo a la API para que la cookie sea del mismo origen
# (en Vercel lo hace el rewrite de apps/web/vercel.json). Se construye con `--target web`.
# Va ANTES de `runtime` a propósito: sin `--target`, docker construye la última etapa, y la CI y el
# despliegue construyen la imagen de los procesos sin indicar destino.
FROM deps AS web-build
RUN pnpm -F @gow/web build

FROM nginx:1.28.0-alpine AS web
COPY infra/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

FROM deps AS runtime
ARG APP=api
ENV APP=${APP} NODE_ENV=production
# Directorios de datos de la pila local (docker-compose.stack.yml): un volumen con nombre hereda el
# dueño de la carpeta de la imagen, así `node` puede escribir en él.
RUN mkdir -p /data/storage /data/whatsapp /data/llm-cache && chown -R node:node /data
USER node
EXPOSE 3000
# `APP` también se puede cambiar al arrancar (api, worker, whatsapp): una sola imagen sirve a los tres.
CMD ["sh", "-c", "exec ./node_modules/.bin/tsx apps/${APP}/src/main.ts"]
