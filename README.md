# Limpeza automática do Azure Container Registry (Node.js)

Todo dia passa por **todos os repositórios** do ACR (`genericos/sienge`, `chat/api`, ...) e
apaga as imagens antigas, mantendo **só a mais recente** de cada um.

Exemplo: `genericos/sienge` com `20251217.1` (17/12/2025) e `20251003.2` (03/10/2025) →
fica `20251217.1`, apaga `20251003.2`.

## Instalação

```bash
npm install
cp .env.example .env   # preencha com o mesmo AZURE_* do app de IP
npm run once           # roda uma vez (começa em dry-run: só mostra o que apagaria)
npm start              # fica rodando e executa todo dia no horário de ACR_CRON
```

Depois de conferir o log do dry-run, mude `ACR_DRY_RUN=false`.

## Permissão na Azure (uma vez só)

O service principal do `.env` precisa poder listar e apagar imagens no registry:

```bash
ACR_ID=$(az acr show --name eveproduseastregistry --query id -o tsv)
az role assignment create --assignee <AZURE_CLIENT_ID> --role AcrPull   --scope $ACR_ID
az role assignment create --assignee <AZURE_CLIENT_ID> --role AcrDelete --scope $ACR_ID
```

(Pelo portal: registry → *Access control (IAM)* → *Add role assignment*.)

## Usar dentro da sua plataforma

Se a plataforma já tem um agendador, importe a função em vez de usar `src/index.js`:

```js
const { cleanupRegistry, optionsFromEnv } = require("./src/acr-cleanup");

const resumo = await cleanupRegistry(optionsFromEnv());
// { repositories, deleted, bytes, errors }
```

## Variáveis

| Variável | Padrão | O que faz |
|---|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | – | Service principal (o mesmo que você já usa) |
| `ACR_NAME` | – | Nome do registry (`eveproduseastregistry`) |
| `ACR_KEEP` | `1` | Quantas imagens manter por repositório |
| `ACR_DRY_RUN` | `true` | `true` só lista; `false` apaga de verdade |
| `ACR_REPO_FILTER` | todos | Regex para limitar repositórios, ex. `^genericos/` |
| `ACR_CRON` | `0 3 * * *` | Horário da execução diária |
| `ACR_TIMEZONE` | `America/Sao_Paulo` | Fuso do `ACR_CRON` |

## Regras

- Uma imagem = um manifest (digest). Se o digest tiver várias tags, ficam todas juntas.
- Imagens com tag têm prioridade: um build sem tag nunca ocupa a vaga da última versão.
- Imagens bloqueadas (`az acr repository update --image repo:tag --delete-enabled false`)
  nunca são apagadas.
- O espaço “liberado” do log é estimado: camadas compartilhadas com a imagem mantida
  continuam ocupando espaço. A Azure leva algumas horas para refletir a redução.
