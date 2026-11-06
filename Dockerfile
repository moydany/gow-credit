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

FROM deps AS runtime
ARG APP=api
ENV APP=${APP} NODE_ENV=production
USER node
EXPOSE 3000
CMD ["sh", "-c", "exec ./node_modules/.bin/tsx apps/${APP}/src/main.ts"]
