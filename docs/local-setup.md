# Correr el repositorio en otra máquina

Guía para pasar el worksample a una computadora nueva y dejarlo funcionando: modo standalone,
evals, escenarios y modo full con el Supabase local. El código llega con `git clone`. Lo demás no
está en git a propósito (`CLAUDE.md`: llaves, PDFs y ground truth nunca se versionan) y se pasa
aparte.

## Qué viaja y cómo

| Qué | Cómo llega a la máquina nueva |
|---|---|
| Código, migraciones, prompts, políticas, escenarios, docs | `git clone` del repositorio privado |
| `.env` de la raíz: tus llaves de Anthropic, Google y TypeSafe | Lo copias tú, por un canal privado |
| `data/dev`, `data/ground-truth` y `data/llm-cache`: los 9 PDFs, el ground truth y la caché de respuestas | Un paquete cifrado de unos 3 MB: `pnpm data:pack` aquí y `pnpm data:unpack` allá |
| Secretos del Supabase local (`infra/supabase/.env` y `app.env`) | No se copian: `pnpm supabase:env` genera unos nuevos |
| La base local: tenants, usuarios, solicitudes | No viaja. Se crea de nuevo; `pnpm demo:load` vuelve a cargar los 9 documentos a costo cero |
| La sesión de WhatsApp | No viaja. Se vuelve a escanear el QR |
| `data/out`, `data/storage`, `data/eval-results` | No hace falta: se regeneran |

Sin el paquete de datos funcionan `pnpm install`, `pnpm typecheck`, `pnpm test` (las pruebas que
necesitan Postgres se saltan solas) y `pnpm run evaluate` sobre tus propios PDFs, pagando las
llamadas. Sin él no funcionan `pnpm eval`, `pnpm demo:load` ni las repeticiones a costo cero.

## Requisitos

- macOS o Linux. En Windows, dentro de WSL2: los scripts de `scripts/` son de shell.
- git, y `gh` para clonar el repositorio privado (o una llave SSH en GitHub).
- Node 24 o posterior. La versión exacta está en `.nvmrc`; con nvm, `nvm install`.
- openssl, para desempacar los datos. macOS y Linux ya lo traen.
- Docker Desktop (o Docker Engine con Compose v2), solo para el modo full. La primera vez descarga
  unos 6.5 GB de imágenes de Supabase.

## 1. En esta máquina: empacar los datos

Elige una frase larga como llave y guárdala en tu gestor de contraseñas. El paquete se cifra con
AES-256 y la llave no va en ningún archivo:

```bash
EVAL_BUNDLE_KEY='tu frase larga' pnpm data:pack ~/gow-data.tar.gz.enc
```

Pasa `~/gow-data.tar.gz.enc` y tu `.env` a la otra máquina por un canal privado: USB, AirDrop o
tu nube personal. La llave del paquete va por otro canal, no junto al archivo.

**Sin llave.** Si lo pasas tú mismo por un medio tuyo (USB, AirDrop), puede ir sin cifrar. El
archivo queda dentro de `data/`, ignorado por git:

```bash
tar -czf data/gow-data.tar.gz data/dev data/ground-truth data/llm-cache
```

Sin cifrar contiene los estados de cuenta: bórralo de la USB, de la nube y de las dos máquinas en
cuanto `pnpm doctor` pase en la nueva.

## 2. En la máquina nueva: clonar e instalar

```bash
gh auth login
```

```bash
gh repo clone moydany/gow-credit
```

```bash
cd gow-credit
```

```bash
corepack enable
```

```bash
pnpm install --frozen-lockfile
```

`corepack enable` instala el pnpm fijado en `package.json` (11.20.0).

## 3. Copiar tu `.env`

Ponlo en la raíz del repositorio, junto a `.env.example`. Es el único archivo de secretos que
copias. Si empiezas sin él, `cp .env.example .env` y llena las llaves (README, tabla de llaves).

## 4. Desempacar los datos

Con el paquete en la máquina nueva:

```bash
EVAL_BUNDLE_KEY='tu frase larga' pnpm data:unpack ~/gow-data.tar.gz.enc
```

Restaura `data/dev`, `data/ground-truth` y `data/llm-cache`, y verifica los PDFs contra su
manifiesto de hashes. Después borra el paquete:

```bash
rm ~/gow-data.tar.gz.enc
```

Si el paquete va sin cifrar, ponlo en la raíz del repositorio y desempácalo desde ahí, no dentro
de `data/`: sus rutas ya empiezan con `data/`. Git lo ignora en la raíz.

```bash
tar -xzf gow-data.tar.gz
```

```bash
rm gow-data.tar.gz
```

Si trabajas con Claude Code en la máquina nueva, `CLAUDE.md` le dice dónde buscar el paquete y
cómo desempacarlo.

Si solo necesitas los PDFs y el enlace compartido sigue vivo, `scripts/download-dev-data.sh` los
baja; el ground truth y la caché solo vienen en el paquete.

## 5. Revisar que no falte nada

```bash
pnpm doctor
```

Revisa Node, pnpm, dependencias, Docker, las llaves de `.env` (sin mostrarlas) y los datos.
Termina en "Listo" o dice qué falta y cómo arreglarlo.

## 6. Comprobar que todo corre, sin gastar

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm eval
```

```bash
pnpm scenario run --all
```

```bash
pnpm run evaluate data/dev --cache read
```

Todos cuestan cero: `pnpm eval` y `--cache read` solo leen respuestas guardadas y nunca llaman a un
modelo. Sin `--cache read`, `evaluate` sobre documentos nuevos sí paga (README, "Costo estimado").

## 7. Modo full con el Supabase local

**Un comando.** Con Docker abierto, `pnpm stack:up` levanta Supabase, migra y arranca la API, el worker,
WhatsApp y el backoffice (ADR 0061). Abre `http://127.0.0.1:5173`: el wizard crea al prestamista y al
administrador y muestra el QR de WhatsApp. `pnpm stack:down` lo detiene y `pnpm stack:reset` borra los
datos. Lo que sigue es la forma manual, para desarrollar con cada proceso en su terminal.

Abre Docker Desktop y sigue estos pasos desde la raíz del repositorio. El detalle está en el
README, "Modo full con Supabase local".

1. Genera los secretos locales y levanta el stack:

   ```bash
   pnpm supabase:env
   ```

   ```bash
   pnpm supabase:up
   ```

2. Carga el entorno de la app en tu shell. Vale solo para esa terminal; repítelo en cada terminal
   nueva que use la base:

   ```bash
   set -a; . infra/supabase/app.env; set +a
   ```

3. Migra, crea el tenant y date de alta:

   ```bash
   pnpm db:migrate
   ```

   ```bash
   pnpm tenant create --name "Prestamista demo"
   ```

   ```bash
   pnpm tenant user add --tenant <id del tenant> --email tu@correo.mx
   ```

   `tenant create` imprime el id del tenant y su llave de API; guarda la llave.

4. Arranca los procesos, cada uno en su terminal con `app.env` cargado:

   ```bash
   pnpm api
   ```

   ```bash
   pnpm worker
   ```

   `app.env` trae `LLM_CACHE_MODE=read`: el worker no gasta en modelos.

5. En otra terminal, la web (no necesita `app.env`):

   ```bash
   pnpm web
   ```

6. Carga los 9 documentos de desarrollo, con `app.env` cargado:

   ```bash
   pnpm demo:load --key <llave del tenant>
   ```

7. Abre `http://127.0.0.1:5173/entrar`, pide el enlace con tu correo y ábrelo desde Inbucket, en
   `http://127.0.0.1:54343`.

Para comprobar el modo full completo, con `app.env` cargado:

```bash
pnpm scenario run --all --mode full
```

WhatsApp es opcional: con `pnpm whatsapp` corriendo (descubre solo al tenant, sin variables), se vincula
en Configuración → Canales, o en el último paso del wizard, escaneando el QR. Sin él, las aclaraciones se responden a mano desde el
backoffice.

## Si algo falla

| Síntoma | Causa y arreglo |
|---|---|
| `pnpm: command not found` o una versión distinta | Falta `corepack enable` |
| `pnpm install` falla compilando `better-sqlite3` | Faltan herramientas de compilación: Xcode Command Line Tools (`xcode-select --install`) en macOS; `build-essential` y `python3` en Linux |
| `bad decrypt` al desempacar | La frase no es la misma con la que se empacó |
| `pnpm eval` reporta `cache_miss` | Falta `data/llm-cache` o está incompleto: vuelve a desempacar el paquete |
| `pnpm supabase:up` falla por puertos | Algo ya usa 54340 a 54343; libéralos |
| La base no acepta la contraseña tras regenerar secretos | El volumen guarda la contraseña vieja: `docker compose -f docker-compose.supabase.yml --env-file infra/supabase/.env down -v` y `pnpm supabase:env --force` |
| Las pruebas de Postgres salen como "skipped" | Es lo esperado sin `app.env` cargado; con él corren contra el Supabase local |
