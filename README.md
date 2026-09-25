# Limpeza automática do Azure Container Registry

Roda uma vez por dia, passa por **todos os repositórios** do ACR (`genericos/sienge`,
`chat/api`, ...) e apaga as imagens antigas, deixando **só a mais recente** de cada um.

Exemplo: em `genericos/sienge` com `20251217.1` (17/12/2025) e `20251003.2` (03/10/2025),
fica a `20251217.1` e a `20251003.2` é apagada.

## Arquivos

- `scripts/acr-cleanup.sh`: faz a limpeza (az CLI + jq). Por padrão roda em **dry-run**.
- `.github/workflows/acr-cleanup.yml`: agenda o script para todo dia às 06:00 UTC (03:00 BRT).

## Configuração (uma vez só)

1. Crie um App Registration na Azure com *Federated credential* para este repositório GitHub
   (entity: branch `main`, ou "Environment" se preferir).
2. Dê a ele a role **AcrDelete** + **AcrPull** (ou *Contributor*) no registry
   `eveproduseastregistry`.
3. Nos *Secrets* do repositório no GitHub, crie `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` e
   `AZURE_SUBSCRIPTION_ID`.
4. (Opcional) crie a *Variable* `ACR_NAME` se o registry for outro.

## Testar antes de apagar

Em **Actions → ACR cleanup → Run workflow**, deixe `dry_run` marcado. O log mostra o que
seria apagado sem apagar nada. Localmente:

```bash
az login
ACR_NAME=eveproduseastregistry ./scripts/acr-cleanup.sh                  # só lista
ACR_NAME=eveproduseastregistry REPO_FILTER='^genericos/sienge$' DRY_RUN=false ./scripts/acr-cleanup.sh
```

## Regras

- Uma "imagem" é um manifest (digest). Se o mesmo digest tiver várias tags, todas ficam juntas.
- Imagens com tag têm prioridade: uma imagem sem tag nunca toma o lugar da última versão com tag.
- Imagens bloqueadas (`deleteEnabled=false`, via `az acr repository update --delete-enabled false`)
  nunca são apagadas; use isso para proteger uma versão específica.
- `KEEP=2` mantém as 2 mais recentes (útil para ter uma versão de rollback).

## Alternativa sem GitHub: ACR Task nativa

A própria Azure tem o comando `acr purge`, que roda dentro do registry com agendamento:

```bash
az acr task create \
  --name purge-diario \
  --registry eveproduseastregistry \
  --cmd "acr purge --filter '.*:.*' --ago 0d --keep 1 --untagged" \
  --schedule "0 6 * * *" \
  --context /dev/null
```

Ela mantém a **tag** mais recente de cada repositório. Teste antes com
`az acr run --registry eveproduseastregistry --cmd "acr purge --filter '.*:.*' --ago 0d --keep 1 --untagged --dry-run" /dev/null`.
