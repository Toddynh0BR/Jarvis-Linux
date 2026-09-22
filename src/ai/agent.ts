import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
    chat,
    ensureOllamaReady,
    OLLAMA_MODEL
} from "./ollama";
import {
    executeTool,
    getOllamaTools,
    type ToolContext
} from "../tools/registry";
import {
    classifyMessage
} from "./router";
import {
    PerformanceTracker,
    formatPerformance
} from "./performance";

const MAX_HISTORY_MESSAGES = 24;

const SYSTEM_PROMPT = `
Você é Jarvis, um assistente local executado no computador do usuário baseado na icónica inteligencia artificial do Home de Ferro, Jarvis.

Regras:
- Responda em português brasileiro, salvo se o usuário pedir outro idioma.
- Seja direto e natural.
- Você pode usar ferramentas disponíveis quando elas forem necessárias.
- Nunca invente que executou uma ação.
- Nunca diga que abriu, criou, apagou ou modificou algo sem receber o resultado da ferramenta.
- Não tente executar comandos de terminal diretamente.
- Não peça ao usuário senhas, especialmente senhas sudo.
- Para ações destrutivas, o sistema deverá exigir confirmação antes da execução.
- Responda diretamente ao usuário.
- Nunca exponha seu raciocínio interno.
- Nunca descreva o processo de decisão da ferramenta.
- Não diga que está analisando a pergunta.
- Não diga que vai verificar novamente.
- Quando uma ferramenta retornar uma informação, use o resultado
- diretamente na resposta.
`;

export interface AgentOptions {
    model?: string;
    context?: ToolContext;
}

export class JarvisAgent {
    private readonly model: string;
    private readonly context: ToolContext;
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
        this.context = options.context ?? {
            cwd: process.cwd()
        };

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

    async ask(userMessage: string): Promise<string> {
        const route = classifyMessage(userMessage);
        const tracker = new PerformanceTracker();

        console.log(
            "[Router] " +
            route.mode +
            " | " +
            route.reason +
            " | confiança " +
            Math.round(route.confidence * 100) +
            "%"
        );

        this.messages.push({
            role: "user",
            content: userMessage
        });

        this.trimHistory();

        const tools = getOllamaTools();
        const think = route.mode === "extended";

        for (let iteration = 0; iteration < 8; iteration++) {
            const response = await chat(
                this.messages,
                this.model,
                tools,
                {
                    think,
                    temperature: route.mode === "extended" ? 0.2 : 0.1,
                    numPredict: route.mode === "extended" ? 768 : 256
                }
            );

            tracker.recordModelResponse(response);

            const assistantMessage = response.message;

            this.messages.push({
                role: "assistant",
                content: assistantMessage.content ?? "",
                thinking: assistantMessage.thinking,
                tool_calls: assistantMessage.tool_calls as any
            });

            const toolCalls = assistantMessage.tool_calls ?? [];

            if (toolCalls.length === 0) {
                const answer = assistantMessage.content?.trim() || "";
                console.log(formatPerformance(tracker.snapshot(route.mode)));
                return answer;
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

                tracker.recordToolCall();
                console.log("\n[Tool] " + name);

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
        }

        console.log(formatPerformance(tracker.snapshot(route.mode)));

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

export async function startAgent(
    options: AgentOptions = {}
): Promise<void> {
    if (!(await ensureOllamaReady())) {
        throw new Error("A API do Ollama não está disponível.");
    }

    const agent = new JarvisAgent(options);

    console.log(`
╔══════════════════════════════════════════════╗
║              JARVIS ESTÁ ONLINE              ║
╚══════════════════════════════════════════════╝

Modelo: ${options.model ?? OLLAMA_MODEL}
Digite "sair" para encerrar.
Digite "limpar" para limpar a conversa.
`);

    const rl = readline.createInterface({
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

            if (["sair", "exit", "quit"].includes(message.toLowerCase())) {
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
                console.log(`\nJarvis > ${answer}\n`);
            } catch (error: any) {
                console.error(
                    `\nJarvis > Erro: ${error?.message ?? error}\n`
                );
            }

            rl.prompt();
        }
    } finally {
        rl.close();
    }
}
