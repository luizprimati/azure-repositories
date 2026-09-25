import { Postgres } from '../../lib/pgserver'
import express = require('express')
import { Controller, Post, Get } from '../../lib/request.decorator'
const cron = require('node-cron');
import { ClientSecretCredential } from '@azure/identity'
import { ContainerRegistryClient, ContainerRegistryContentClient, KnownContainerRegistryAudience, ArtifactManifestProperties } from '@azure/container-registry'

import * as dotenv from 'dotenv'
dotenv.config()

//*******************************************************************************
//* Autenticação no Azure Container Registry — usa o mesmo App Registration do
//* NSG (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET).
//* O App Registration precisa das roles AcrPull e AcrDelete no registry.
//*******************************************************************************
const ACR_NAME    = process.env.ACR_NAME || 'eveproduseastregistry';
const ACR_KEEP    = Number(process.env.ACR_KEEP || 1);            // quantas imagens manter por repositório
const ACR_FILTRO  = new RegExp(process.env.ACR_REPO_FILTER || '.*'); // ex: ^genericos/
const ACR_LOCK_ID = 1007;

const ACR_ENDPOINT = `https://${ACR_NAME}.azurecr.io`;
const ACR_OPCOES   = { audience: KnownContainerRegistryAudience.AzureResourceManagerPublicCloud };

let acrCredential: ClientSecretCredential | null = null;
let acrClient: ContainerRegistryClient | null = null;

function getAcrCredential(): ClientSecretCredential {
    if (!acrCredential) {
        // O SDK renova o token sozinho, não precisa de cache manual como no Graph
        acrCredential = new ClientSecretCredential(
            process.env.AZURE_TENANT_ID!,
            process.env.AZURE_CLIENT_ID!,
            process.env.AZURE_CLIENT_SECRET!,
        );
    }
    return acrCredential;
}

function getAcrClient(): ContainerRegistryClient {
    if (!acrClient) {
        acrClient = new ContainerRegistryClient(ACR_ENDPOINT, getAcrCredential(), ACR_OPCOES);
    }
    return acrClient;
}

//*******************************************************************************
//* Cron: limpa o registry todo dia às 03:00 (lock via Postgres, mesmo padrão
//* dos jobs do Helpdesk — evita rodar em paralelo se subir mais de 1 instância)
//*******************************************************************************
cron.schedule(process.env.ACR_CRON || '0 3 * * *', async () => {
    try {
        if (process.env.ACR_LIMPEZA_ATIVO == '0') {
            console.log('Job limpeza do ACR está desativado, pulando...');
            return;
        }
        // ACR_DRY_RUN=1 -> só mostra no log o que seria apagado
        await new AcrLimpezaController().executarComLock(process.env.ACR_DRY_RUN == '1');
    } catch (err) {
        console.error('Erro no cron limpeza do ACR:', err);
    }
}, { timezone: 'America/Sao_Paulo' });

@Controller('/acrLimpeza')
export class AcrLimpezaController {

    public cErroMsgRunQuery: string = 'Um erro ocorreu ao executar sua consulta.'

    //*******************************************************************************
    //* GET /acrLimpeza/simular — mostra o que seria apagado, sem apagar nada
    //*******************************************************************************
    @Get('/simular')
    private async simular(req, res): Promise<any> {
        try {
            const resultado = await this.limparRegistry(true);
            return res.status(200).send({ status: 'success', ...resultado });
        } catch (err) {
            return res.status(500).json({
                status: 'error',
                description: this.cErroMsgRunQuery,
                message: err instanceof Error ? err.message : String(err),
                error: err
            });
        }
    }

    //*******************************************************************************
    //* POST /acrLimpeza/executar — dispara a limpeza agora. Responde na hora e
    //* roda em segundo plano (a 1ª limpeza pode levar vários minutos).
    //*******************************************************************************
    @Post('/executar')
    private async executar(req, res): Promise<any> {
        this.executarComLock(false).catch(err => console.error('Erro na limpeza manual do ACR:', err));
        return res.status(202).send({ status: 'success', message: 'Limpeza do ACR iniciada, acompanhe pelo log.' });
    }

    public async executarComLock(dryRun: boolean): Promise<any> {
        const DB_HELP = new Postgres('help_desk');

        const { rows } = await DB_HELP.runQuery(`SELECT pg_try_advisory_lock(${ACR_LOCK_ID}) AS acquired`);
        if (!rows[0].acquired) {
            console.log('Job limpeza do ACR já em execução, pulando...');
            return { ok: false, motivo: 'já em execução' };
        }

        try {
            return await this.limparRegistry(dryRun);
        } finally {
            await DB_HELP.runQuery(`SELECT pg_advisory_unlock(${ACR_LOCK_ID})`);
        }
    }

    //*******************************************************************************
    //* limparRegistry — varre repositório por repositório e apaga todas as imagens
    //* menos as ACR_KEEP mais recentes. Imagens com exclusão bloqueada no portal
    //* (canDelete = false) nunca são apagadas.
    //*******************************************************************************
    private async limparRegistry(dryRun: boolean): Promise<any> {
        console.log(`${dryRun ? '[simulação] ' : ''}Limpando ACR ${ACR_NAME}, mantendo ${ACR_KEEP} imagem(ns) por repositório...`);

        const client = getAcrClient();
        const repositorios: any[] = [];
        let totalApagadas = 0;
        let totalBytes = 0;
        let totalErros = 0;

        for await (const nomeRepo of client.listRepositoryNames()) {
            if (!ACR_FILTRO.test(nomeRepo)) continue;

            try {
                const repo = client.getRepository(nomeRepo);

                const manifests: ArtifactManifestProperties[] = [];
                for await (const m of repo.listManifestProperties({ order: 'LastUpdatedOnDescending' })) {
                    manifests.push(m);
                }

                // Imagens com tag primeiro (sort estável mantém "mais nova primeiro"),
                // assim um build sem tag nunca ocupa a vaga da última versão.
                const semTag = (m: ArtifactManifestProperties) => (m.tags?.length ? 0 : 1);
                manifests.sort((a, b) => semTag(a) - semTag(b));

                const mantidas = manifests.slice(0, ACR_KEEP);
                const protegidas = manifests.filter(m => m.canDelete === false);

                // Imagens multi-arquitetura (buildx) são um "índice" com tag que aponta para
                // manifests SEM tag. Apagar esses filhos quebra a imagem mantida, então
                // eles ficam protegidos. Se não der para ler o índice, não apaga nenhuma
                // imagem sem tag deste repositório (prefere sobrar do que quebrar).
                const filhos = await this.digestsReferenciados(nomeRepo, [...mantidas, ...protegidas]);

                const apagar = manifests.slice(ACR_KEEP).filter(m =>
                    m.canDelete !== false &&
                    !(filhos === null && !m.tags?.length) &&
                    !(filhos !== null && filhos.has(m.digest))
                );

                if (apagar.length === 0) continue;

                const apagadas: any[] = [];
                for (const m of apagar) {
                    try {
                        if (!dryRun) {
                            await repo.getArtifact(m.digest).delete();
                        }
                        apagadas.push({ tags: this.nomeImagem(m), data: m.lastUpdatedOn });
                        totalApagadas++;
                        totalBytes += m.sizeInBytes || 0;
                    } catch (errImagem) {
                        totalErros++;
                        console.error(`Erro ao apagar ${nomeRepo}@${m.digest}:`, errImagem);
                    }
                }

                console.log(`[${nomeRepo}] mantida ${mantidas.map(this.nomeImagem).join(', ')} | ${dryRun ? 'seriam apagadas' : 'apagadas'}: ${apagadas.length}`);
                repositorios.push({ repositorio: nomeRepo, mantidas: mantidas.map(this.nomeImagem), apagadas });

            } catch (errRepo) {
                totalErros++;
                console.error(`Erro ao processar repositório ${nomeRepo}:`, errRepo);
            }
        }

        const liberado = (totalBytes / 1024 ** 3).toFixed(2) + ' GB';
        console.log(`${dryRun ? '[simulação] ' : ''}ACR: ${totalApagadas} imagem(ns) ${dryRun ? 'seriam apagadas' : 'apagadas'}, ~${liberado} liberados, ${totalErros} erro(s).`);

        return { ok: true, dryRun, totalApagadas, liberado, totalErros, repositorios };
    }

    //*******************************************************************************
    //* digestsReferenciados — digests dos manifests filhos das imagens informadas
    //* (plataformas e atestados de um índice multi-arquitetura). null = falhou.
    //*******************************************************************************
    private async digestsReferenciados(nomeRepo: string, imagens: ArtifactManifestProperties[]): Promise<Set<string> | null> {
        const digests = new Set<string>();
        try {
            const conteudo = new ContainerRegistryContentClient(ACR_ENDPOINT, nomeRepo, getAcrCredential(), ACR_OPCOES);
            for (const img of imagens) {
                for (const rel of img.relatedArtifacts || []) {
                    if (rel.digest) digests.add(rel.digest);
                }
                const { manifest } = await conteudo.getManifest(img.digest);
                const lista = (manifest as any).manifests;
                if (Array.isArray(lista)) {
                    for (const filho of lista) {
                        if (filho?.digest) digests.add(filho.digest);
                    }
                }
            }
            return digests;
        } catch (err) {
            console.error(`[${nomeRepo}] não foi possível ler o índice da imagem mantida, imagens sem tag serão preservadas:`, err);
            return null;
        }
    }

    private nomeImagem(m: ArtifactManifestProperties): string {
        return m.tags?.length ? m.tags.join(',') : m.digest.substring(0, 19);
    }
}
