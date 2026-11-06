#!/usr/bin/env bash
# Paquete cifrado con lo que necesita `pnpm eval` y no se versiona (ADR 0012): los PDFs de
# desarrollo, el ground truth y la caché de respuestas. CI lo restaura desde almacenamiento
# privado; el paquete nunca va al repositorio.
#
#   EVAL_BUNDLE_KEY=... scripts/eval-bundle.sh pack  [salida.tar.gz.enc]
#   EVAL_BUNDLE_KEY=... scripts/eval-bundle.sh unpack <entrada.tar.gz.enc>
#
# Cifrado AES-256-CBC con PBKDF2. La llave vive en un secreto de CI, nunca en el repositorio.
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
