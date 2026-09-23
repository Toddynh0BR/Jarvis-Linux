import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
    chat,
    ensureOllamaReady,
    isModelInstalled,
    OLLAMA_FAST_MODEL,
    OLLAMA_MODEL
} from "./ollama";
import {
    executeTool,
    getOllamaTools,
    type ToolContext
} from "../tools/registry";
import {
    classifyMessage,
    type ResponseMode,
    type ResponseDepth
} from "./router";
import { resolveDirectToolIntent } from "../tools/intent";
import { JarvisTTS } from "../audio/tts";
import {
    PerformanceTracker,
    formatPerformance
} from "./performance";

const MAX_HISTORY_MESSAGES = 24;
const FAST_MAX_TOKENS = 96;
const STANDARD_MAX_TOKENS = 384;
const DEEP_MAX_TOKENS = 768;
const EXTENDED_RETRY_TOKENS = 256;
const EXTENDED_THINKING = false;

const SYSTEM_PROMPT = `
Você é Jarvis, um assistente local executado no computador do usuário.

Regras:
- Responda em português brasileiro, salvo se o usuário pedir outro idioma.
- Seja direto, natural e útil.
- Use ferramentas quando elas forem necessárias.
- Nunca invente que executou uma ação.
- Nunca diga que abriu, criou, apagou ou modificou algo sem resultado da ferramenta.
- Não execute comandos de terminal diretamente.
- Nunca peça senhas ao usuário.
- Ações destrutivas exigem confirmação antes da execução.
- Responda somente com a resposta final destinada ao usuário.
- Nunca exponha raciocínio interno, pensamentos, rascunhos ou meta-comentários.
- Nunca descreva como decidiu usar uma ferramenta.
- Nunca diga que está analisando, verificando ou pensando.
- Nunca comece com "Okay, the user...", "Let me...", "I need to..." ou equivalentes.
- Não narre seu processo de elaboração da resposta.
- Não comece a resposta descrevendo o pedido do usuário.
- Não use frases como "First, I..." ou equivalentes.
- Comece diretamente pela resposta ao usuário.
`;

export interface AgentOptions {
    model?: string;
    context?: ToolContext;
}

export class JarvisAgent {
    private readonly model: string;
    private readonly context: ToolContext;
    private fastModelAvailable: boolean | null = null;

    private messages: Array<{
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
    }>;

    constructor(options: AgentOptions = {}) {
        this.model = options.model ?? OLLAMA_MODEL;
        this.context = options.context ?? { cwd: process.cwd() };

        this.messages = [
            {
                role: "system",
                content: SYSTEM_PROMPT
            }
        ];
    }

    private trimHistory(): void {
        if (this.messages.length <= MAX_HISTORY_MESSAGES) {
            return;
        }

        const systemMessage = this.messages[0];

        this.messages = [
            systemMessage,
            ...this.messages.slice(-MAX_HISTORY_MESSAGES + 1)
        ];
    }

    private async resolveModel(
        mode: ResponseMode,
        toolPreferred = false
    ): Promise<string> {
        if (
            mode !== "fast" ||
            toolPreferred ||
            OLLAMA_FAST_MODEL === this.model
        ) {
            return this.model;
        }

        if (this.fastModelAvailable === null) {
            this.fastModelAvailable = await isModelInstalled(
                OLLAMA_FAST_MODEL
            );
        }

        return this.fastModelAvailable
            ? OLLAMA_FAST_MODEL
            : this.model;
    }

    async ask(userMessage: string): Promise<string> {
        const route = classifyMessage(userMessage);
        const tracker = new PerformanceTracker();
        const directTool = resolveDirectToolIntent(userMessage);

        if (directTool) {
            tracker.recordToolCall();\n
            const result = await executeTool(
                directTool.toolName,
                directTool.args,
                this.context
            );

            const answer = formatDirectToolResult(
                directTool.type,
                result
            );

            console.log(
                formatPerformance(tracker.snapshot(route.mode))
            );

            return answer;
        }

        const model = await this.resolveModel(
            route.mode,
            route.toolPreferred === true
        );
        this.messages.push({
            role: "user",
            content: userMessage
        });

        this.trimHistory();

        // Ferramentas só entram no prompt quando a rota indica intenção de ferramenta.
        const tools = route.toolPreferred
            ? getOllamaTools()
            : undefined;

        const think =
            route.mode === "extended" &&
            EXTENDED_THINKING;

        const maxTokens = getMaxOutputTokens(route.mode, route.depth);

        for (let iteration = 0; iteration < 8; iteration++) {
            const response = await chat(
                this.messages,
                model,
                tools,
                {
                    think,
                    temperature: 0.7,
                    topP: 0.8,
                    topK: 20,
                    numPredict: maxTokens
                }
            );

            tracker.recordModelResponse(response);

            if (
                response.eval_count !== undefined &&
                response.eval_count >= maxTokens
            ) {\n                }

            const assistantMessage = response.message;
            const toolCalls = assistantMessage.tool_calls ?? [];
            const rawContent = assistantMessage.content?.trim() ?? "";
            const content = cleanAssistantContent(rawContent);

            if (
                toolCalls.length === 0 &&
                route.mode === "extended" &&
                containsReasoningLeak(rawContent)
            ) {\n
                const retry = await chat(
                    this.messages,
                    model,
                    undefined,
                    {
                        think: false,
                        temperature: 0.1,
                        numPredict: EXTENDED_RETRY_TOKENS
                    }
                );

                tracker.recordModelResponse(retry);

                const retryRaw = retry.message.content?.trim() ?? "";
                const retryAnswer = cleanAssistantContent(retryRaw);

                if (
                    retryAnswer &&
                    !containsReasoningLeak(retryRaw)
                ) {
                    this.messages.push({
                        role: "assistant",
                        content: retryAnswer
                    });\n
                    return retryAnswer;
                }\n
                return "Não consegui gerar uma resposta final para essa solicitação.";
            }

            if (
                toolCalls.length === 0 &&
                !content &&
                route.mode === "extended"
            ) {\n
                const fallback = await chat(
                    this.messages,
                    model,
                    undefined,
                    {
                        think: false,
                        temperature: 0.2,
                        numPredict: EXTENDED_RETRY_TOKENS
                    }
                );

                tracker.recordModelResponse(fallback);

                const fallbackAnswer = cleanAssistantContent(
                    fallback.message.content?.trim() ?? ""
                );

                this.messages.push({
                    role: "assistant",
                    content: fallbackAnswer
                });\n
                return fallbackAnswer;
            }

            this.messages.push({
                role: "assistant",
                content: assistantMessage.content ?? "",
                thinking: assistantMessage.thinking,
                tool_calls: assistantMessage.tool_calls as any
            });

            if (toolCalls.length === 0) {\n
                return content;
            }

            for (const call of toolCalls) {
                const name = call.function.name;
                let args: Record<string, unknown> = {};

                try {
                    args =
                        typeof call.function.arguments === "string"
                            ? JSON.parse(call.function.arguments)
                            : call.function.arguments ?? {};
                } catch {
                    args = {};
                }

                tracker.recordToolCall();\n
                const result = await executeTool(
                    name,
                    args,
                    this.context
                );

                this.messages.push({
                    role: "tool",
                    tool_name: name,
                    content: result
                });
            }

            this.trimHistory();
        }\n
        return "Não consegui concluir a solicitação porque o limite de execução de ferramentas foi atingido.";
    }

    clearConversation(): void {
        this.messages = [
            {
                role: "system",
                content: SYSTEM_PROMPT
            }
        ];
    }
}

function getMaxOutputTokens(
    mode: ResponseMode,
    depth: ResponseDepth
): number {
    if (mode === "fast" || depth === "fast") {
        return FAST_MAX_TOKENS;
    }

    return depth === "deep"
        ? DEEP_MAX_TOKENS
        : STANDARD_MAX_TOKENS;
}

function containsReasoningLeak(content: string): boolean {
    return /(?:okay, the user|the user (?:is|wants|asks)|let me (?:think|check)|i need to|first, i|hmm,|wait,|let's (?:think|see)|the user is asking)/i.test(
        content
    );
}

function cleanAssistantContent(content: string): string {
    return content
        .replace(/<think>[\\s\\S]*?<\\/think>/gi, "")
        .replace(/<think>[\\s\\S]*/gi, "")
        .replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, "$1")
        .replace(/\\x60{3}[a-zA-Z0-9_-]*\\n?/g, "")
        .replace(/\\x60/g, "")
        .replace(/^\\s*#{1,6}\\s*/gm, "")
        .replace(/^\\s*[-*+]\\s+/gm, "")
        .replace(/^\\s*\\d+[.)]\\s+/gm, "")
        .replace(/^\\s*[-*_]{3,}\\s*$/gm, "")
        .replace(/\\*{1,3}|_{1,3}/g, "")
        .replace(/\\u00a0/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\\|/g, ", ")
        .replace(/--+/g, ", ")
        .replace(/—|–/g, ", ")
        .replace(/[\\u{1F1E6}-\\u{1F1FF}\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu, "")
        .replace(/[ \\t]+/g, " ")
        .replace(/ \\n /g, "\\n")
        .replace(/\\n{3,}/g, "\\n\\n")
        .trim();
}

function formatDirectToolResult(
    type: "systemStatus" | "openUrl",
    result: string
): string {
    try {
        const data = JSON.parse(result) as Record<string, unknown>;

        if (type === "openUrl") {
            if (data.success === true) {
                return String(
                    data.message ?? "URL aberta com sucesso."
                );
            }

            return String(
                data.error ?? "Não foi possível abrir a URL."
            );
        }

        if (data.error) {
            return (
                "Não consegui obter as informações do sistema: " +
                String(data.error)
            );
        }

        return [
            "Informações do sistema:",
            `• Sistema: ${String(data.distribution ?? data.os ?? "desconhecido")}`,
            `• Kernel: ${String(data.kernel ?? "desconhecido")}`,
            `• CPU: ${String(data.cpu ?? "desconhecida")}`,
            `• Núcleos/threads: ${String(data.cores ?? "?")}/${String(data.threads ?? "?")}`,
            `• RAM: ${String(data.ramGB ?? "?")} GB`,
            `• RAM disponível: ${String(data.availableRamGB ?? "?")} GB`,
            `• GPU: ${String(data.gpu ?? "desconhecida")}`,
            `• Armazenamento livre: ${String(data.storageFreeGB ?? "?")} GB`
        ].join("\n");
    } catch {
        return result;
    }
}

export async function startAgent(
    options: AgentOptions = {}
): Promise<void> {
    if (!(await ensureOllamaReady())) {
        throw new Error("A API do Ollama não está disponível.");
    }

    const agent = new JarvisAgent(options);
    const tts = new JarvisTTS();

    console.log(`
╔══════════════════════════════════════════════╗
║              JARVIS ESTÁ ONLINE              ║
╚══════════════════════════════════════════════╝

Modelo principal: ${options.model ?? OLLAMA_MODEL}
Modelo rápido: ${OLLAMA_FAST_MODEL}
Thinking: desativado
Digite "sair" para encerrar.
Digite "limpar" para limpar a conversa.
`);

    // Pré-carrega o motor de voz em segundo plano para que a primeira resposta\n    // não precise esperar a inicialização do modelo. Falhas continuam silenciosas\n    // até que uma fala seja solicitada.\n    void tts.start().catch(() => undefined);\n\n    const rl = readline.createInterface({
        input,
        output,
        prompt: "Você > "
    });

    rl.prompt();

    try {
        for await (const line of rl) {
            const message = line.trim();

            if (!message) {
                rl.prompt();
                continue;
            }

            if (
                ["sair", "exit", "quit"].includes(
                    message.toLowerCase()
                )
            ) {
                break;
            }

            if (message.toLowerCase() === "limpar") {
                agent.clearConversation();
                console.log("✓ Conversa limpa.\n");
                rl.prompt();
                continue;
            }

            try {
                const answer = await agent.ask(message);
                console.log("\nJarvis > " + answer + "\n");
                await tts.speak(answer);
            } catch (error: any) {
                console.error(
                    "\nJarvis > Erro: " +
                    (error?.message ?? error) +
                    "\n"
                );
            }

            rl.prompt();
        }
    } finally {
        rl.close();
        await tts.stop();
    }
}
