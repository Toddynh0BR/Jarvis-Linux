import * as path from "node:path";
import {
    bytesToGB,
    printSystemInfo,
    runDiagnostics,
    type SystemInfo
} from "./diagnostics";
import {
    initializeDatabase,
    saveCompatibility,
    saveSystemInfo,
    DATABASE_PATH
} from "../database/database";
import { delay } from "./setup";

export const COMPATIBILITY_CHECK_VERSION = 1;

export const MIN_RAM_GB = 8;
export const MIN_FREE_STORAGE_GB = 10;

export interface CompatibilityResult {
    supported: boolean;
    reasons: string[];
    warnings: string[];
    checkVersion: number;
}

export function checkCompatibility(
    system: SystemInfo
): CompatibilityResult {
    const reasons: string[] = [];
    const warnings: string[] = [];

    if (system.os !== "Linux") {
        reasons.push("Esta versão do Jarvis suporta somente Linux.");
    }

    if (
        system.architecture !== "x64" &&
        system.architecture !== "arm64"
    ) {
        reasons.push(
            "Arquitetura não suportada: " + system.architecture
        );
    }

    if (bytesToGB(system.ramTotalBytes) < MIN_RAM_GB) {
        reasons.push(
            "RAM insuficiente. Mínimo recomendado: " +
            MIN_RAM_GB +
            " GB."
        );
    }

    if (bytesToGB(system.rootFreeBytes) < MIN_FREE_STORAGE_GB) {
        reasons.push(
            "Espaço livre insuficiente. Necessário pelo menos " +
            MIN_FREE_STORAGE_GB +
            " GB."
        );
    }

    const supportedDistributions = ["cachyos", "arch"];

    if (
        !supportedDistributions.includes(
            system.distribution.toLowerCase()
        )
    ) {
        warnings.push(
            "Distribuição " +
            system.prettyDistributionName +
            " não é oficialmente suportada nesta versão."
        );
    }

    if (system.initSystem !== "systemd") {
        warnings.push(
            "systemd não foi detectado. O gerenciamento automático do Ollama pode não funcionar."
        );
    }

    if (/amd|radeon/i.test(system.gpu)) {
        warnings.push(
            "GPU AMD detectada. A aceleração dependerá do suporte disponível no ambiente."
        );
    }

    if (!system.tools.node?.installed) {
        reasons.push("Node.js não foi encontrado.");
    }

    if (!system.tools.git?.installed) {
        warnings.push("Git não foi encontrado.");
    }

    return {
        supported: reasons.length === 0,
        reasons,
        warnings,
        checkVersion: COMPATIBILITY_CHECK_VERSION
    };
};

export async function printCompatibility(
    result: CompatibilityResult
): Promise<void> {
    console.log("\nCompatibilidade");
    console.log("──────────────────────────────────────────────");

    await delay(1000)

    if (result.supported) {
        console.log("✓ Sistema compatível com o Jarvis.");
    } else {
        console.log("✗ Sistema incompatível.");

        for (const reason of result.reasons) {
            console.log("  • " + reason);
        }
    }

    await delay(1000)

    if (result.warnings.length > 0) {
        console.log("\nAvisos:");

        for (const warning of result.warnings) {
            console.log("  • " + warning);
        }
    }
}

export async function runCompatibilityCheck(): Promise<{
    system: SystemInfo;
    compatibility: CompatibilityResult;
}> {
    const system = await runDiagnostics();
    await printSystemInfo(system);

    await delay(1000)

    const compatibility = checkCompatibility(system);
    await printCompatibility(compatibility);

    return { system, compatibility };
}

async function runCompatibilityCommand(): Promise<void> {
    const db = initializeDatabase();

    try {
        const { system, compatibility } =
            await runCompatibilityCheck();

        await delay(1000)

        await saveSystemInfo(db, system);

        await delay(1000)

        await saveCompatibility(db, compatibility);

        await delay(1000)

        console.log(
            "\n✓ Diagnóstico e compatibilidade salvos em " +
            DATABASE_PATH
        );

        process.exitCode = compatibility.supported ? 0 : 1;
    } finally {
        db.close();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    runCompatibilityCommand().catch(error => {
        console.error(
            "\nErro na verificação:",
            error?.message ?? error
        );
        process.exit(1);
    });
}
