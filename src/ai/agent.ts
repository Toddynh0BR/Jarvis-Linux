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

const SYSTEM_PROMPT = `
Você é Jarvis, um assistente local executado no computador do usuário.

Regras:
- Responda em português brasileiro, salvo se o usuário pedir outro idioma.
- Seja direto e natural.
- Você pode usar ferramentas disponíveis quando elas forem necessárias.
- Nunca invente que executou uma ação.
- Nunca diga que abriu, criou, apagou ou modificou algo sem receber o resultado da ferramenta.
- Não tente executar comandos de terminal diretamente.
- Não peça ao usuário senhas, especialmente senhas sudo.
- Para ações destrutivas, o sistema deverá exigir confirmação antes da execução.
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

    async ask(userMessage: string): Promise<string> {
        this.messages.push({
            role: "user",
            content: userMessage
        });

        const tools = getOllamaTools();

        // Limite de iterações evita loops de ferramentas.
        for (let iteration = 0; iteration < 8; iteration++) {
            const response = await chat(
                this.messages,
                this.model,
                tools
            );

            const assistantMessage = response.message;

            this.messages.push({
                role: "assistant",
                content: assistantMessage.content ?? ""
            });

            const toolCalls = assistantMessage.tool_calls ?? [];

            if (toolCalls.length === 0) {
                return assistantMessage.content?.trim() || "";
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

                console.log(`\n[Tool] ${name}`);

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
        }

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
