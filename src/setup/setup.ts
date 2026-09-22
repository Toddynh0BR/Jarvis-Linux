import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
    DATABASE_PATH,
    COMPATIBILITY_CHECK_VERSION,
    getLatestCompatibility,
    getLatestSystemInfo,
    initializeDatabase,
    saveCompatibility,
    saveOllamaInfo,
    saveSystemInfo
} from "../database/database";
import {
    checkCompatibility,
    printCompatibility,
    type CompatibilityResult
} from "./compatibility.js";
import {
    runDiagnostics,
    printSystemInfo,
    commandExists,
    getCommandVersion,
    type SystemInfo
} from "./diagnostics.js";
import {
    ensureOllamaReady,
    getOllamaState,
    installModel,
    testModel,
    OLLAMA_MODEL
} from "../ai/ollama.js";

export interface SetupResult {
    compatible: boolean;
    system: SystemInfo;
    compatibility: CompatibilityResult;
    ollamaReady: boolean;
}

async function askConfirmation(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input, output });

    try {
        const answer = await rl.question(question + " [s/N] ");
        return ["s", "sim", "y", "yes"].includes(
            answer.trim().toLowerCase()
        );
    } finally {
        rl.close();
    }
}

async function installOllama(): Promise<boolean> {
    console.log("\nO Ollama não está instalado.");
    console.log(
        "O instalador oficial pode solicitar sua senha através do sudo."
    );
    console.log("O Jarvis não verá nem armazenará sua senha.\n");

    if (!(await askConfirmation("Deseja instalar o Ollama agora?"))) {
        return false;
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(
            "sh",
            ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
            { stdio: "inherit" }
        );

        child.on("error", reject);
        child.on("close", code => resolve(code ?? 1));
    });

    return exitCode === 0;
}

export async function performSetup(
    db: Database.Database,
    options: {
        forceCompatibilityCheck?: boolean;
        validateModel?: boolean;
    } = {}
): Promise<SetupResult> {
    const cached = getLatestCompatibility(db);

    let system: SystemInfo;
    let compatibility: CompatibilityResult;

    const shouldCheck =
        options.forceCompatibilityCheck === true ||
        !cached ||
        cached.checkVersion !== COMPATIBILITY_CHECK_VERSION;

    if (shouldCheck) {
        console.log(
            cached
                ? "\nA versão da verificação mudou. Executando novo diagnóstico..."
                : "\nNenhuma verificação de compatibilidade encontrada. Executando diagnóstico..."
        );

        system = await runDiagnostics();
        compatibility = checkCompatibility(system);

        printSystemInfo(system);
        printCompatibility(compatibility);

        saveSystemInfo(db, system);
        saveCompatibility(db, compatibility);
    } else {
        console.log("\n✓ Compatibilidade já verificada.");

        const storedSystem = getLatestSystemInfo(db);

        if (!storedSystem) {
            console.log(
                "Informações do sistema não encontradas. Refazendo diagnóstico..."
            );

            system = await runDiagnostics();
            compatibility = checkCompatibility(system);

            printSystemInfo(system);
            printCompatibility(compatibility);

            saveSystemInfo(db, system);
            saveCompatibility(db, compatibility);
        } else {
            system = storedSystem;
            compatibility = {
                supported: cached.supported,
                reasons: cached.reasons,
                warnings: cached.warnings,
                checkVersion: cached.checkVersion
            };

            printCompatibility(compatibility);
        }
    }

    if (!compatibility.supported) {
        return {
            compatible: false,
            system,
            compatibility,
            ollamaReady: false
        };
    }

    const ollamaReady = await ensureOllamaSetup(db, {
        validateModel: options.validateModel ?? true
    });

    return {
        compatible: true,
        system,
        compatibility,
        ollamaReady
    };
}

export async function ensureOllamaSetup(
    db: Database.Database,
    options: {
        validateModel?: boolean;
    } = {}
): Promise<boolean> {
    let installed = await commandExists("ollama");

    if (!installed) {
        installed = await installOllama();
    }

    if (!installed) {
        console.log("\nO Ollama não está disponível. Encerrando.");
        return false;
    }

    const version = await getCommandVersion(
        "ollama",
        ["--version"]
    );

    const apiReady = await ensureOllamaReady();

    if (!apiReady) {
        console.error(
            "\n✗ A API do Ollama não está disponível. " +
            "Endpoint esperado: http://127.0.0.1:11434"
        );
        return false;
    }

    const modelReady = await installModel();

    const state = await getOllamaState();

    saveOllamaInfo(db, {
        installed: state.installed,
        version,
        serviceRunning: state.serviceRunning,
        apiAvailable: state.apiAvailable,
        modelInstalled: modelReady,
        modelName: OLLAMA_MODEL
    });

    if (!modelReady) {
        return false;
    }

    if (options.validateModel === false) {
        return true;
    }

    const aiReady = await testModel();

    if (!aiReady) {
        console.error("\n✗ O modelo não respondeu corretamente.");
        return false;
    }

    return true;
}

export async function runSetupCommand(): Promise<void> {
    const db = initializeDatabase();

    try {
        console.log(
            "\n╔══════════════════════════════════════════════╗\n" +
            "║                 J A R V I S                  ║\n" +
            "║                  SETUP                       ║\n" +
            "╚══════════════════════════════════════════════╝\n"
        );

        console.log("Banco: " + DATABASE_PATH);

        const result = await performSetup(db, {
            forceCompatibilityCheck: true,
            validateModel: true
        });

        if (!result.compatible) {
            console.log(
                "\nO Jarvis não pode continuar neste computador."
            );
            process.exitCode = 1;
            return;
        }

        if (!result.ollamaReady) {
            console.log("\nSetup incompleto.");
            process.exitCode = 1;
            return;
        }

        console.log("\n✓ Setup concluído.");
    } finally {
        db.close();
    }
}

if (
    process.argv[1] &&
    process.argv[1].endsWith("setup.ts")
) {
    runSetupCommand().catch(error => {
        console.error("\nErro fatal no setup:", error);
        process.exit(1);
    });
}
