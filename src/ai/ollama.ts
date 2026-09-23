import ollama from "ollama";
import { spawn } from "node:child_process";
import {
    commandExists,
    getCommandVersion,
    runCommand
} from "../setup/diagnostics";

export const OLLAMA_API_URL =
    process.env.OLLAMA_HOST?.startsWith("http")
        ? process.env.OLLAMA_HOST
        : "http://127.0.0.1:11434";

export const OLLAMA_MODEL =
    // Qwen3-4B-Instruct-2507 is the official non-thinking 4B variant.
    // This avoids relying on Qwen3-4B thinking toggles for the main model.
    process.env.JARVIS_MODEL ?? "qwen3:4b-instruct";

export const OLLAMA_FAST_MODEL =
    process.env.JARVIS_FAST_MODEL ?? "qwen3:1.7b";

export interface OllamaState {
    installed: boolean;
    version: string | null;
    serviceRunning: boolean;
    apiAvailable: boolean;
    modelInstalled: boolean;
}

async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

export async function isOllamaInstalled(): Promise<boolean> {
    return commandExists("ollama");
}

export async function getOllamaVersion(): Promise<string | null> {
    if (!(await isOllamaInstalled())) return null;

    return getCommandVersion("ollama", ["--version"]);
}

export async function isOllamaServiceRunning(): Promise<boolean> {
    if (!(await commandExists("systemctl"))) return false;

    const result = await runCommand(
        "systemctl",
        ["is-active", "--quiet", "ollama"]
    );

    return result.code === 0;
}

export async function isOllamaAPIAvailable(): Promise<boolean> {
    try {
        const response = await fetch(`${OLLAMA_API_URL}/api/tags`, {
            signal: AbortSignal.timeout(3000)
        });

        return response.ok;
    } catch {
        return false;
    }
}

export async function isModelInstalled(
    modelName = OLLAMA_MODEL
): Promise<boolean> {
    if (!(await isOllamaInstalled())) return false;

    const result = await runCommand("ollama", ["list"]);

    if (result.code !== 0) return false;

    return result.stdout
        .split("\n")
        .some(line => {
            const name = line.trim().split(/\s+/)[0];
            return name === modelName;
        });
}

async function startOllamaDirectly(): Promise<boolean> {
    const child = spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore"
    });

    child.unref();

    for (let attempt = 0; attempt < 15; attempt++) {
        if (await isOllamaAPIAvailable()) return true;
        await sleep(1000);
    }

    return false;
}

export async function ensureOllamaReady(): Promise<boolean> {
    if (await isOllamaAPIAvailable()) return true;

    if (!(await isOllamaInstalled())) return false;

    if (await commandExists("systemctl")) {
        const serviceRunning = await isOllamaServiceRunning();

        if (!serviceRunning) {
            console.log("Iniciando serviço Ollama...");

            // sudo recebe a senha diretamente do terminal porque stdio é herdado.
            const result = await new Promise<number>(resolve => {
                const child = spawn(
                    "sudo",
                    ["systemctl", "start", "ollama"],
                    { stdio: "inherit" }
                );

                child.on("error", () => resolve(1));
                child.on("close", code => resolve(code ?? 1));
            });

            if (result !== 0) {
                console.error(
                    "Não foi possível iniciar o serviço Ollama."
                );
            }
        }

        for (let attempt = 0; attempt < 10; attempt++) {
            if (await isOllamaAPIAvailable()) return true;
            await sleep(1000);
        }
    }

    return startOllamaDirectly();
}

export async function installModel(
    modelName = OLLAMA_MODEL
): Promise<boolean> {
    if (await isModelInstalled(modelName)) {
        console.log(`✓ Modelo ${modelName} já está instalado.`);
        return true;
    }

    console.log(`\nO modelo ${modelName} não está instalado.`);

    // O download é uma ação grande e, por isso, não acontece silenciosamente.
    const readline = await import("node:readline/promises");
    const { stdin, stdout } = await import("node:process");
    const rl = readline.createInterface({ input: stdin, output: stdout });

    try {
        const answer = await rl.question(
            `Baixar ${modelName} agora? [s/N] `
        );

        if (!["s", "sim", "y", "yes"].includes(
            answer.trim().toLowerCase()
        )) {
            return false;
        }
    } finally {
        rl.close();
    }

    const result = await new Promise<number>(resolve => {
        const child = spawn("ollama", ["pull", modelName], {
            stdio: "inherit"
        });

        child.on("error", () => resolve(1));
        child.on("close", code => resolve(code ?? 1));
    });

    return result === 0 && await isModelInstalled(modelName)
        ? true
        : false;
}

export async function testModel(
    modelName = OLLAMA_MODEL
): Promise<boolean> {
    try {
        const response = await ollama.chat({
            model: modelName,
            think: false,
            messages: [
                {
                    role: "user",
                    content: "Responda somente: JARVIS ONLINE."
                }
            ],
            options: {
                temperature: 0
            }
        });

        const content = response.message.content.trim();

        console.log(`Jarvis: ${content}`);

        return content.length > 0;
    } catch (error: any) {
        console.error(
            "Erro ao conversar com o modelo:",
            error?.message ?? error
        );

        return false;
    }
}

export type ThinkingMode = boolean | "low" | "medium" | "high";

export interface ChatOptions {
    think?: ThinkingMode;
    keepAlive?: string | number;
    temperature?: number;
    numPredict?: number;
}

type OllamaChatMessage = Parameters<typeof ollama.chat>[0]["messages"] extends
    Array<infer Message>
    ? Message
    : never;

export async function chat(
    messages: Array<{
        role: "system" | "user" | "assistant" | "tool";
        content: string;
        tool_name?: string;
        thinking?: string;
        tool_calls?: Array<{
            function: {
                name: string;
                arguments: Record<string, unknown> | string;
            };
        }>;
    }>,
    modelName = OLLAMA_MODEL,
    tools?: any[],
    options: ChatOptions = {}
) {
    const thinkingDisabled = options.think === false;

    const normalizedMessages: OllamaChatMessage[] = messages.map(
        (message, index) => ({
            role: message.role,
            content:
                thinkingDisabled &&
                index === 0 &&
                message.role === "system"
                    ? message.content.trimEnd() + "\n/no_think"
                    : message.content,
            ...(message.tool_name
                ? { tool_name: message.tool_name }
                : {}),
            ...(message.thinking
                ? { thinking: message.thinking }
                : {}),
            ...(message.tool_calls
                ? {
                    tool_calls: message.tool_calls.map(toolCall => ({
                        function: {
                            name: toolCall.function.name,
                            arguments:
                                typeof toolCall.function.arguments === "string"
                                    ? parseToolArguments(
                                        toolCall.function.arguments
                                    )
                                    : toolCall.function.arguments
                        }
                    }))
                }
                : {})
        })
    ) as OllamaChatMessage[];

    return ollama.chat({
        model: modelName,
        messages: normalizedMessages,
        tools,
        stream: false,
        think: options.think ?? false,
        keep_alive:
            options.keepAlive ??
            process.env.JARVIS_KEEP_ALIVE ??
            "10m",
        options: {
            temperature: options.temperature ?? 0.2,
            ...(options.numPredict
                ? { num_predict: options.numPredict }
                : {})
        }
    });
}

function parseToolArguments(
    argumentsValue: string
): Record<string, unknown> {
    try {
        const parsed = JSON.parse(argumentsValue);

        return parsed && typeof parsed === "object"
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

export async function getOllamaState(): Promise<OllamaState> {
    const installed = await isOllamaInstalled();
    const version = await getOllamaVersion();
    const apiAvailable = installed
        ? await isOllamaAPIAvailable()
        : false;
    const serviceRunning = installed
        ? await isOllamaServiceRunning()
        : false;
    const modelInstalled = installed
        ? await isModelInstalled()
        : false;

    return {
        installed,
        version,
        serviceRunning,
        apiAvailable,
        modelInstalled
    };
}
