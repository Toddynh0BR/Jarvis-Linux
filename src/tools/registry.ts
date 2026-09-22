import { spawn } from "node:child_process";
import { commandExists, runCommand } from "../setup/diagnostics";
import {
    getLatestSystemInfo,
    initializeDatabase
} from "../database/database";

export interface ToolContext {
    cwd: string;
}

export interface JarvisTool {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
    execute: (
        args: Record<string, unknown>,
        context: ToolContext
    ) => Promise<string>;
}

function isSafeUrl(value: string): boolean {
    try {
        const url = new URL(value);

        return (
            url.protocol === "https:" ||
            url.protocol === "http:"
        );
    } catch {
        return false;
    }
}

const getSystemStatus: JarvisTool = {
    name: "getSystemStatus",
    description:
        "Retorna informações básicas do sistema detectadas pelo Jarvis, como sistema operacional, CPU, RAM, GPU e armazenamento.",
    parameters: {
        type: "object",
        properties: {}
    },
    async execute() {
        const db = initializeDatabase();

        try {
            const system = getLatestSystemInfo(db);

            if (!system) {
                return JSON.stringify({
                    error: "Nenhum diagnóstico do sistema foi encontrado."
                });
            }

            return JSON.stringify({
                os: system.os,
                distribution: system.prettyDistributionName,
                architecture: system.architecture,
                kernel: system.kernel,
                cpu: system.cpuModel,
                cores: system.cpuCores,
                threads: system.cpuThreads,
                ramGB: Number(
                    (system.ramTotalBytes / 1024 ** 3).toFixed(1)
                ),
                availableRamGB: Number(
                    (system.ramAvailableBytes / 1024 ** 3).toFixed(1)
                ),
                gpu: system.gpu,
                storageFreeGB: Number(
                    (system.rootFreeBytes / 1024 ** 3).toFixed(1)
                )
            });
        } finally {
            db.close();
        }
    }
};

const openUrl: JarvisTool = {
    name: "openUrl",
    description:
        "Abre uma URL HTTP ou HTTPS no navegador padrão do sistema. Use somente quando o usuário pedir explicitamente para abrir um endereço.",
    parameters: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "URL HTTP ou HTTPS a ser aberta."
            }
        },
        required: ["url"]
    },
    async execute(args) {
        const url = String(args.url ?? "").trim();

        if (!isSafeUrl(url)) {
            return JSON.stringify({
                success: false,
                error: "Somente URLs http:// e https:// são permitidas."
            });
        }

        if (!(await commandExists("xdg-open"))) {
            return JSON.stringify({
                success: false,
                error: "xdg-open não está disponível neste sistema."
            });
        }

        const child = spawn("xdg-open", [url], {
            detached: true,
            stdio: "ignore"
        });

        child.unref();

        return JSON.stringify({
            success: true,
            message: `URL aberta: ${url}`
        });
    }
};

const listTools: JarvisTool = {
    name: "listAvailableTools",
    description:
        "Lista as ferramentas que o Jarvis pode utilizar nesta versão.",
    parameters: {
        type: "object",
        properties: {}
    },
    async execute() {
        return JSON.stringify(
            toolRegistry.map(tool => ({
                name: tool.name,
                description: tool.description
            }))
        );
    }
};

export const toolRegistry: JarvisTool[] = [
    getSystemStatus,
    openUrl,
    listTools
];

export function getTool(name: string): JarvisTool | undefined {
    return toolRegistry.find(tool => tool.name === name);
}

export function getOllamaTools() {
    return toolRegistry.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }
    }));
}

export async function executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext
): Promise<string> {
    const tool = getTool(name);

    if (!tool) {
        return JSON.stringify({
            success: false,
            error: `Ferramenta desconhecida: ${name}`
        });
    }

    try {
        return await tool.execute(args, context);
    } catch (error: any) {
        return JSON.stringify({
            success: false,
            error: error?.message ?? String(error)
        });
    }
}
