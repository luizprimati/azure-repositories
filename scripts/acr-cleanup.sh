#!/usr/bin/env bash
#
# Limpa o Azure Container Registry mantendo apenas as N imagens mais recentes
# de cada repositório (padrão: 1).
#
# Uso:
#   ACR_NAME=eveproduseastregistry ./scripts/acr-cleanup.sh            # dry-run (só lista)
#   ACR_NAME=eveproduseastregistry DRY_RUN=false ./scripts/acr-cleanup.sh
#
# Variáveis:
#   ACR_NAME      nome do registry (obrigatório)
#   KEEP          quantas imagens manter por repositório (padrão: 1)
#   DRY_RUN       "true" apenas mostra o que seria apagado (padrão: true)
#   REPO_FILTER   regex (grep -E) para limitar os repositórios (padrão: todos)
#
# Requer: az CLI autenticado (az login) e jq.

set -euo pipefail

ACR_NAME="${ACR_NAME:?defina ACR_NAME}"
KEEP="${KEEP:-1}"
DRY_RUN="${DRY_RUN:-true}"
REPO_FILTER="${REPO_FILTER:-.*}"

echo "Registry: $ACR_NAME | manter: $KEEP | dry-run: $DRY_RUN | filtro: $REPO_FILTER"

total_deleted=0

while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue

  # Manifests ordenados do mais novo para o mais antigo.
  # Cada manifest = uma imagem (pode ter 0, 1 ou várias tags).
  manifests=$(az acr manifest list-metadata \
    --registry "$ACR_NAME" \
    --name "$repo" \
    --orderby time_desc \
    --output json \
    | jq 'sort_by(if (.tags // []) | length > 0 then 0 else 1 end)')
  # ^ imagens com tag vêm primeiro (ordem estável mantém "mais nova primeiro"),
  #   assim uma imagem sem tag nunca "ocupa a vaga" da última versão com tag.

  count=$(jq 'length' <<<"$manifests")
  if (( count <= KEEP )); then
    echo "[$repo] $count imagem(ns) - nada a apagar"
    continue
  fi

  keep_tags=$(jq -r --argjson k "$KEEP" '.[:$k] | map((.tags // ["<sem tag>"]) | join(",")) | join(" | ")' <<<"$manifests")
  echo "[$repo] $count imagem(ns) - mantendo: $keep_tags"

  # Pula os KEEP mais recentes e os que estão bloqueados contra exclusão.
  while IFS=$'\t' read -r digest updated tags; do
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] apagaria $repo@$digest ($tags, $updated)"
    else
      echo "  apagando $repo@$digest ($tags, $updated)"
      az acr repository delete \
        --name "$ACR_NAME" \
        --image "$repo@$digest" \
        --yes --output none
    fi
    total_deleted=$((total_deleted + 1))
  done < <(jq -r --argjson k "$KEEP" '
    .[$k:][]
    | select((.changeableAttributes.deleteEnabled // true) == true)
    | [.digest, .lastUpdateTime, ((.tags // ["<sem tag>"]) | join(","))]
    | @tsv' <<<"$manifests")

done < <(az acr repository list --name "$ACR_NAME" --output tsv | grep -E "$REPO_FILTER" || true)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Total que seria apagado: $total_deleted imagem(ns). Rode com DRY_RUN=false para apagar."
else
  echo "Total apagado: $total_deleted imagem(ns)."
fi
