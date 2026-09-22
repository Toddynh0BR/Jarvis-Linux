import {
    initializeDatabase,
    getLatestCompatibility,
    getLatestSystemInfo,
    COMPATIBILITY_CHECK_VERSION
} from "./database/database";
import { performSetup, ensureOllamaSetup } from "./setup/setup.js";
import { printCompatibility } from "./setup/compatibility";
import { startAgent } from "./ai/agent";

function printBanner(): void {
    console.clear();

    console.log(
        "\n╔══════════════════════════════════════════════╗\n" +
        "║                  J A R V I S                 ║\n" +
        "║             Local AI Assistant               ║\n" +
        "╚══════════════════════════════════════════════╝\n"
    );
}

async function main(): Promise<void> {
    if (process.platform !== "linux") {
        console.error(
            "Esta versão do Jarvis foi desenvolvida para Linux."
        );
        process.exitCode = 1;
        return;
    }

    printBanner();

    const db = initializeDatabase();

    try {
        console.log("Verificando estado do Jarvis...\n");

        const cachedCompatibility = getLatestCompatibility(db);

        if (
            !cachedCompatibility ||
            cachedCompatibility.checkVersion !==
                COMPATIBILITY_CHECK_VERSION
        ) {
            console.log(
                "Nenhuma verificação válida encontrada."
            );

            const result = await performSetup(db, {
                forceCompatibilityCheck: true,
                validateModel: true
            });

            if (!result.compatible) {
                console.log(
                    "\nO Jarvis será encerrado porque o sistema não é compatível."
                );
                process.exitCode = 1;
                return;
            }

            if (!result.ollamaReady) {
                console.log(
                    "\nO ambiente do Jarvis ainda não está pronto."
                );
                process.exitCode = 1;
                return;
            }
        } else if (!cachedCompatibility.supported) {
            console.log(
                "✗ Uma verificação anterior marcou este sistema como incompatível.\n"
            );

            printCompatibility({
                supported: cachedCompatibility.supported,
                reasons: cachedCompatibility.reasons,
                warnings: cachedCompatibility.warnings,
                checkVersion: cachedCompatibility.checkVersion
            });

            console.log("\nO Jarvis será encerrado.");
            process.exitCode = 1;
            return;
        } else {
            console.log("✓ Compatibilidade já verificada.");
            console.log("✓ Sistema compatível.");

            const system = getLatestSystemInfo(db);

            if (system) {
                console.log(
                    "✓ Ambiente: " +
                    system.prettyDistributionName +
                    " / " +
                    system.architecture
                );
            }

            // O diagnóstico e o teste de inferência não são repetidos
            // em todo npm start. Apenas garantimos que Ollama/API/modelo
            // estejam disponíveis.
            const ollamaReady = await ensureOllamaSetup(db, {
                validateModel: false
            });

            if (!ollamaReady) {
                console.log(
                    "\nO ambiente do Ollama não está pronto."
                );
                process.exitCode = 1;
                return;
            }
        }

        console.log("\nIniciando Agent...\n");

        await startAgent({
            context: {
                cwd: process.cwd()
            }
        });
    } finally {
        db.close();
    }
}

main().catch(error => {
    console.error("\nErro fatal no Jarvis:");
    console.error(error);
    process.exitCode = 1;
});
