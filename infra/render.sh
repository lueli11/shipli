#!/usr/bin/env bash
# Füllt ${SHIPLI_*} in einer Vorlage aus der Umgebung und gibt sie aus. Fehlt eine Variable, kommt gar nichts heraus
# (-0777: erst die ganze Datei ersetzen, dann ausgeben), damit nie ein halbes Manifest bei kubectl landet.
# Aufruf: infra/render.sh <datei>
set -euo pipefail
[ $# = 1 ] || { echo "Aufruf: infra/render.sh <datei>" >&2; exit 2; }
exec perl -0777 -pe 's/\$\{(SHIPLI_\w+)\}/exists $ENV{$1} ? $ENV{$1} : die "$ARGV: \${$1} fehlt in der Konfiguration\n"/ge' "$1"
