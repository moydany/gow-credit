#!/usr/bin/env bash
# Downloads the 9 dev statements from the shared Drive to data/dev/.
# Needs the folder to still be shared by link. Verifies against MANIFEST.sha256.
set -euo pipefail
mkdir -p "$(dirname "$0")/../data/dev" && cp "$(dirname "$0")/dev-data.MANIFEST.sha256" "$(dirname "$0")/../data/dev/MANIFEST.sha256" && cd "$(dirname "$0")/../data/dev"
while IFS='|' read -r name id; do
  [ -s "$name" ] && { echo "ya existe: $name"; continue; }
  echo "descargando $name"
  curl -sL -o "$name" "https://drive.google.com/uc?export=download&confirm=t&id=$id"
done <<'LIST'
EDC_01_Inbursa_2025-01.pdf|1zmygY82VWOJzoXNpO4B4HU5XPTTQCQAx
EDC_02_Hey_2025-04.pdf|1cok8kmI-KECxCzBDD50KQ_kwFepMUsWY
EDC_03_Fondeadora_2025-10.pdf|1kx2PJ_cZj0JFwsrpzYcyGhz2syS-n3sX
EDC_04_Banamex_2026-02.pdf|1Fab9wBxmlAk5Z5AASJdSBr-hy7IrVGaR
EDC_05_BBVA_2025-09.pdf|1XjiancbSswBpi-AGO47Y1Ivhyo10IuZE
EDC_06_MercadoPago_2026-06a09.pdf|16IqOwl_FFDJLzOvTffhSkoTlFQQbwCDB
EDC_07_Santander_2025-04.pdf|1CwZwKedXtPfk_NVF4XTIxQw8a1aGVBGe
EDC_08_Nu_2025-07.pdf|13-Di6A25S6U7-NWvEXivKZs1cEGo2nK8
EDC_09_HSBC_2026-03.pdf|11BGodq3KX5_ZPCsVDTKoNZJ8ZSd5nlM9
LIST
shasum -a 256 -c MANIFEST.sha256
