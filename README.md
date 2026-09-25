# Limpeza automática do Azure Container Registry

Controller no padrão da plataforma (`@Controller` + `node-cron` + lock no Postgres) que,
todo dia às 03:00, varre todos os repositórios do ACR e apaga as imagens antigas,
mantendo só a mais recente de cada um.

Arquivo: `src/controllers/azure/acrLimpeza.ts` — copie para a pasta de controllers da
plataforma (os imports `../../lib/...` seguem o mesmo padrão do `EmailHelpdeskController`).

## Dependências

```bash
npm install @azure/identity @azure/container-registry
```

## .env

Usa o mesmo App Registration do NSG (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`). Variáveis novas, todas opcionais:

```env
ACR_NAME=eveproduseastregistry
ACR_KEEP=1            # quantas imagens manter por repositório
ACR_DRY_RUN=1         # 1 = cron só loga o que apagaria. Tire depois de conferir.
ACR_LIMPEZA_ATIVO=1   # 0 desativa o cron
ACR_CRON=0 3 * * *    # horário de Brasília
ACR_REPO_FILTER=      # regex opcional, ex: ^genericos/
```

## Permissão na Azure (uma vez)

Registry → *Access control (IAM)* → *Add role assignment* → roles **AcrPull** e
**AcrDelete** para o App Registration do `AZURE_CLIENT_ID`. Ou:

```bash
ACR_ID=$(az acr show --name eveproduseastregistry --query id -o tsv)
az role assignment create --assignee <AZURE_CLIENT_ID> --role AcrPull   --scope $ACR_ID
az role assignment create --assignee <AZURE_CLIENT_ID> --role AcrDelete --scope $ACR_ID
```

## Endpoints

- `GET  /acrLimpeza/simular` — lista o que seria apagado, sem apagar.
- `POST /acrLimpeza/executar` — dispara a limpeza agora (roda em segundo plano, resultado no log).

## Regras

- Uma imagem = um manifest (digest); tags do mesmo digest saem juntas.
- Imagens com tag têm prioridade sobre as sem tag na hora de escolher a que fica.
- Imagens com exclusão bloqueada no portal nunca são apagadas.
- Lock `pg_advisory_lock(1007)` no banco `help_desk` evita execução paralela entre instâncias.
