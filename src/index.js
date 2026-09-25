// Uso:
//   node --env-file=.env src/index.js          -> agenda e fica rodando (ACR_CRON)
//   node --env-file=.env src/index.js --once   -> roda uma vez e sai
const cron = require("node-cron");
const { cleanupRegistry, optionsFromEnv } = require("./acr-cleanup");

const schedule = process.env.ACR_CRON || "0 3 * * *";
const timezone = process.env.ACR_TIMEZONE || "America/Sao_Paulo";

let running = false;

async function run() {
  if (running) return console.warn("Limpeza anterior ainda em andamento, pulando.");
  running = true;
  try {
    return await cleanupRegistry(optionsFromEnv());
  } catch (err) {
    console.error("Falha na limpeza do ACR:", err);
    process.exitCode = 1;
  } finally {
    running = false;
  }
}

if (process.argv.includes("--once")) {
  run();
} else {
  cron.schedule(schedule, run, { timezone });
  console.log(`Limpeza do ACR agendada: "${schedule}" (${timezone})`);
}
