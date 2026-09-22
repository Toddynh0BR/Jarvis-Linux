import { ensureOllamaReady, OLLAMA_MODEL } from "../ai/ollama";
import { JarvisAgent } from "../ai/agent";
import { classifyMessage, type ResponseMode } from "../ai/router";

interface BenchmarkCase {
    name: string;
    prompt: string;
    expectedMode: ResponseMode;
    keywords?: string[];
    expectTool?: boolean;
}

const cases: BenchmarkCase[] = [
    {
        name: "Sistema operacional",
        prompt: "Qual sistema operacional estou usando?",
        expectedMode: "fast",
        keywords: ["cachy", "linux"],
        expectTool: true
    },
    {
        name: "CPU",
        prompt: "Qual é meu processador?",
        expectedMode: "fast",
        keywords: ["5600gt", "amd"],
        expectTool: true
    },
    {
        name: "Saudação",
        prompt: "Olá Jarvis",
        expectedMode: "fast"
    },
    {
        name: "Explicação REST",
        prompt: "Explique como funciona uma API REST e quais são seus principais componentes.",
        expectedMode: "extended",
        keywords: ["http", "api"]
    },
    {
        name: "Comparação",
        prompt: "Compare Node.js, Spring Boot e FastAPI considerando desempenho, ecossistema e facilidade de desenvolvimento.",
        expectedMode: "extended",
        keywords: ["node", "spring", "fastapi"]
    },
    {
        name: "Programação",
        prompt: "Analise este problema de programação e explique como eu poderia estruturar uma solução em TypeScript.",
        expectedMode: "extended",
        keywords: ["typescript"]
    },
    {
        name: "Causal",
        prompt: "Por que uma aplicação Node.js pode ficar lenta mesmo usando operações assíncronas?",
        expectedMode: "extended",
        keywords: ["event", "bloque"]
    },
    {
        name: "Ferramenta",
        prompt: "Mostre as informações do meu sistema.",
        expectedMode: "fast",
        keywords: ["cpu", "ram"],
        expectTool: true
    }
];

function containsKeywords(answer: string, keywords: string[]): string[] {
    const normalized = answer.toLocaleLowerCase("pt-BR");

    return keywords.filter(keyword =>
        normalized.includes(keyword.toLocaleLowerCase("pt-BR"))
    );
}

function containsLeakedMeta(answer: string): boolean {
    return /\b(okay, the user|let me (think|check)|i need to|first, i|o usuário está pedindo|vou analisar|preciso verificar)\b/i.test(
        answer
    );
}

async function main(): Promise<void> {
    console.log(
        "\n╔══════════════════════════════════════════════╗\n" +
        "║             JARVIS PHASE 2 TEST             ║\n" +
        "║          Performance & Reasoning            ║\n" +
        "╚══════════════════════════════════════════════╝\n"
    );

    if (!(await ensureOllamaReady())) {
        throw new Error("Ollama não está disponível.");
    }

    console.log("Modelo: " + OLLAMA_MODEL);
    console.log("Casos: " + cases.length + "\n");

    const agent = new JarvisAgent();

    console.log(
        "\nAquecendo o modelo para separar custo de carregamento dos testes..."
    );

    const warmupStarted = performance.now();

    try {
        await agent.ask("Responda somente: OK.");
        console.log(
            "Aquecimento concluído em " +
            ((performance.now() - warmupStarted) / 1000).toFixed(2) +
            "s."
        );
    } catch (error: any) {
        console.log(
            "⚠ Aquecimento falhou: " +
            (error?.message ?? String(error))
        );
    }

    let passedRouting = 0;
    let nonEmptyAnswers = 0;
    let semanticPasses = 0;
    let cleanAnswers = 0;
    let toolIntentPasses = 0;

    for (const test of cases) {
        agent.clearConversation();

        const route = classifyMessage(test.prompt);

        console.log("\n[" + test.name + "]");
        console.log("Pergunta: " + test.prompt);
        console.log(
            "Rota: " +
            route.mode +
            " | esperado: " +
            test.expectedMode +
            " | confiança: " +
            Math.round(route.confidence * 100) +
            "%"
        );
        console.log("Motivo: " + route.reason);

        if (route.mode === test.expectedMode) {
            passedRouting++;
        } else {
            console.log("⚠ Roteamento diferente do esperado.");
        }

        const started = performance.now();

        try {
            const answer = await agent.ask(test.prompt);
            const duration = performance.now() - started;

            if (answer.trim()) {
                nonEmptyAnswers++;
            }

            const matched = test.keywords
                ? containsKeywords(answer, test.keywords)
                : [];

            const leakedMeta = containsLeakedMeta(answer);

            if (!leakedMeta) {
                cleanAnswers++;
            }

            const keywordPass =
                !test.keywords ||
                matched.length === test.keywords.length;

            if (keywordPass && !leakedMeta) {
                semanticPasses++;
            }

            if (test.expectTool) {
                const toolDetected = route.toolPreferred === true;

                if (toolDetected) {
                    toolIntentPasses++;
                }

                console.log(
                    "Intenção de ferramenta: " +
                    (toolDetected ? "detectada" : "não detectada")
                );
            }

            console.log(
                "Tempo externo: " +
                (duration / 1000).toFixed(2) +
                "s"
            );
            console.log(
                "Resposta: " +
                answer.replace(/\s+/g, " ").slice(0, 500)
            );
            console.log(
                "Saída limpa: " +
                (leakedMeta ? "NÃO" : "SIM")
            );

            if (test.keywords) {
                console.log(
                    "Palavras esperadas: " +
                    matched.length +
                    "/" +
                    test.keywords.length +
                    (matched.length < test.keywords.length
                        ? " | ausentes: " +
                          test.keywords
                              .filter(k => !matched.includes(k))
                              .join(", ")
                        : "")
                );
            }
        } catch (error: any) {
            console.log(
                "✗ Erro: " +
                (error?.message ?? String(error))
            );
        }
    }

    console.log(
        "\n══════════════════════════════════════════════\n" +
        "RESUMO\n" +
        "══════════════════════════════════════════════\n" +
        "Roteamento: " +
        passedRouting +
        "/" +
        cases.length +
        "\n" +
        "Respostas não vazias: " +
        nonEmptyAnswers +
        "/" +
        cases.length +
        "\n" +
        "Respostas sem vazamento de raciocínio: " +
        cleanAnswers +
        "/" +
        cases.length +
        "\n" +
        "Casos com sinais semânticos esperados: " +
        semanticPasses +
        "/" +
        cases.length +
        "\n" +
        "Intenções de ferramenta detectadas: " +
        toolIntentPasses +
        "/3\n\n" +
        "Observação:\n" +
        "Este benchmark mede roteamento, latência e sinais básicos de resposta.\n" +
        "A qualidade semântica final deve ser revisada manualmente durante os testes.\n"
    );
}

main().catch(error => {
    console.error("\nBenchmark encerrado com erro:");
    console.error(error);
    process.exitCode = 1;
});
