#!/bin/sh
# Before each `app` deploy: give the process roles their login and password, then migrate. Both are
# idempotent.
set -eu
./node_modules/.bin/tsx packages/db/src/cli/roles.ts
./node_modules/.bin/tsx packages/db/src/cli/migrate.ts
