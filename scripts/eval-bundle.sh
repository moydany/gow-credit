#!/usr/bin/env bash
# Encrypted bundle with what `pnpm eval` needs and isn't versioned: the dev PDFs, the ground truth
# and the response cache. CI restores it from private storage; the bundle never goes in the repo.
#
#   EVAL_BUNDLE_KEY=... scripts/eval-bundle.sh pack  [out.tar.gz.enc]
#   EVAL_BUNDLE_KEY=... scripts/eval-bundle.sh unpack <in.tar.gz.enc>
#
# AES-256-CBC with PBKDF2. The key lives in a CI secret, never in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${EVAL_BUNDLE_KEY:?falta EVAL_BUNDLE_KEY}"
case "${1:-}" in
  pack)
    out="${2:-eval-bundle.tar.gz.enc}"
    tar -czf - data/dev data/ground-truth data/llm-cache \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:EVAL_BUNDLE_KEY -out "$out"
    echo "paquete: $out ($(wc -c < "$out" | tr -d ' ') bytes)"
    ;;
  unpack)
    in="${2:?falta el archivo}"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:EVAL_BUNDLE_KEY -in "$in" | tar -xzf -
    (cd data/dev && shasum -a 256 -c MANIFEST.sha256 --quiet)
    echo "restaurado en data/"
    ;;
  *) echo "uso: $0 pack [salida] | unpack <entrada>" >&2; exit 64 ;;
esac
