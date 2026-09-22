import * as path from "node:path";
import {
    bytesToGB,
    printSystemInfo,
    runDiagnostics,
    type SystemInfo
} from "./diagnostics";

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
        reasons.push(`Arquitetura não suportada: ${system.architecture}`);
    }

    if (bytesToGB(system.ramTotalBytes) < MIN_RAM_GB) {
        reasons.push(
            `RAM insuficiente. Mínimo recomendado: ${MIN_RAM_GB} GB.`
        );
    }

    if (bytesToGB(system.rootFreeBytes) < MIN_FREE_STORAGE_GB) {
        reasons.push(
            `Espaço livre insuficiente. Necessário pelo menos ${MIN_FREE_STORAGE_GB} GB.`
        );
    }

    const supportedDistributions = ["cachyos", "arch"];

    if (
        !supportedDistributions.includes(
            system.distribution.toLowerCase()
        )
    ) {
        warnings.push(
            `Distribuição ${system.prettyDistributionName} não é oficialmente suportada nesta versão.`
        );
    }

    if (system.initSystem !== "systemd") {
        warnings.push(
            "systemd não foi detectado. O gerenciamento automático do Ollama pode não funcionar."
        );
    }

    if (
        /amd|radeon/i.test(system.gpu)
    ) {
        warnings.push(
            "GPU AMD detectada. A aceleração dependerá do suporte disponível no ambiente."
        );
    }

    if (!system.tools.node.installed) {
        reasons.push("Node.js não foi encontrado.");
    }

    if (!system.tools.git.installed) {
        warnings.push("Git não foi encontrado.");
    }

    return {
        supported: reasons.length === 0,
        reasons,
        warnings,
        checkVersion: COMPATIBILITY_CHECK_VERSION
    };
}

export function printCompatibility(result: CompatibilityResult): void {
    console.log("\nCompatibilidade");
    console.log("──────────────────────────────────────────────");

    if (result.supported) {
        console.log("✓ Sistema compatível com o Jarvis.");
    } else {
        console.log("✗ Sistema incompatível.");

        for (const reason of result.reasons) {
            console.log(`  • ${reason}`);
        }
    }

    if (result.warnings.length > 0) {
        console.log("\nAvisos:");

        for (const warning of result.warnings) {
            console.log(`  • ${warning}`);
        }
    }
}

export async function runCompatibilityCheck(): Promise<{
    system: SystemInfo;
    compatibility: CompatibilityResult;
}> {
    const system = await runDiagnostics();
    printSystemInfo(system);

    const compatibility = checkCompatibility(system);
    printCompatibility(compatibility);

    return { system, compatibility };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    runCompatibilityCheck()
        .then(({ compatibility }) => {
            process.exitCode = compatibility.supported ? 0 : 1;
        })
        .catch(error => {
            console.error("\nErro na verificação:", error.message);
            process.exit(1);
        });
}
