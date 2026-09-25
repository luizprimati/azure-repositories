const { ClientSecretCredential } = require("@azure/identity");
const {
  ContainerRegistryClient,
  KnownContainerRegistryAudience,
} = require("@azure/container-registry");

/**
 * Apaga as imagens antigas de todos os repositórios do ACR, mantendo só as
 * `keep` mais recentes de cada um.
 *
 * Uma "imagem" é um manifest (digest). Imagens com tag têm prioridade sobre
 * as sem tag, para que um build sem tag nunca ocupe a vaga da última versão.
 * Imagens com exclusão bloqueada (canDelete = false) nunca são apagadas.
 */
async function cleanupRegistry({
  registry,
  tenantId,
  clientId,
  clientSecret,
  keep = 1,
  dryRun = true,
  repoFilter = /.*/,
  logger = console,
  client, // opcional: injetar um ContainerRegistryClient (testes)
} = {}) {
  if (!registry) throw new Error("ACR_NAME não definido");

  const endpoint = registry.includes(".")
    ? `https://${registry.replace(/^https?:\/\//, "")}`
    : `https://${registry}.azurecr.io`;

  client ??= new ContainerRegistryClient(
    endpoint,
    new ClientSecretCredential(tenantId, clientId, clientSecret),
    { audience: KnownContainerRegistryAudience.AzureResourceManagerPublicCloud },
  );

  const summary = { repositories: 0, deleted: 0, bytes: 0, errors: 0 };
  const prefix = dryRun ? "[dry-run] " : "";

  logger.log(`${prefix}ACR ${endpoint} | manter ${keep} por repositório`);

  for await (const repoName of client.listRepositoryNames()) {
    if (!repoFilter.test(repoName)) continue;
    summary.repositories++;

    const repo = client.getRepository(repoName);
    const manifests = [];
    for await (const m of repo.listManifestProperties({ order: "LastUpdatedOnDescending" })) {
      manifests.push(m);
    }

    // sort é estável: dentro de cada grupo a ordem "mais nova primeiro" é mantida.
    const hasTag = (m) => (m.tags && m.tags.length > 0 ? 0 : 1);
    manifests.sort((a, b) => hasTag(a) - hasTag(b));

    const toDelete = manifests.slice(keep).filter((m) => m.canDelete !== false);
    if (toDelete.length === 0) continue;

    const kept = manifests.slice(0, keep).map(label).join(", ");
    logger.log(`[${repoName}] ${manifests.length} imagens, mantendo ${kept}`);

    for (const m of toDelete) {
      try {
        if (!dryRun) await repo.getArtifact(m.digest).delete();
        summary.deleted++;
        summary.bytes += m.sizeInBytes || 0;
        logger.log(`  ${dryRun ? "apagaria" : "apagada"} ${label(m)} (${m.lastUpdatedOn.toISOString()})`);
      } catch (err) {
        summary.errors++;
        logger.error(`  erro ao apagar ${repoName}@${m.digest}: ${err.message}`);
      }
    }
  }

  logger.log(
    `${prefix}${summary.deleted} imagens ${dryRun ? "seriam apagadas" : "apagadas"} em ${summary.repositories} repositórios, ` +
      `~${formatBytes(summary.bytes)} liberados, ${summary.errors} erros`,
  );
  return summary;
}

function label(m) {
  return m.tags && m.tags.length ? m.tags.join(",") : m.digest.slice(0, 19);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function optionsFromEnv(env = process.env) {
  return {
    registry: env.ACR_NAME,
    tenantId: env.AZURE_TENANT_ID,
    clientId: env.AZURE_CLIENT_ID,
    clientSecret: env.AZURE_CLIENT_SECRET,
    keep: Number(env.ACR_KEEP || 1),
    dryRun: env.ACR_DRY_RUN !== "false",
    repoFilter: new RegExp(env.ACR_REPO_FILTER || ".*"),
  };
}

module.exports = { cleanupRegistry, optionsFromEnv };
