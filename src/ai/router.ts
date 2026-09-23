export type ResponseMode = "fast" | "extended";
export type ResponseDepth = "fast" | "standard" | "deep";

export interface RouteDecision {
    mode: ResponseMode;
    depth: ResponseDepth;
    reason: string;
    confidence: number;
    toolPreferred?: boolean;
}

const TOOL_INTENT_PATTERNS = [
    /\b(meu|minha|meus|minhas)\s+(sistema|processador|cpu|ram|mem[oó]ria|gpu|placa de v[ií]deo|kernel)\b/i,
    /\b(sistema operacional|informa[cç][oõ]es do sistema|status do sistema)\b/i,
    /\b(abra|abrir|feche|fechar|inicie|iniciar|execute|executar)\b/i
];

const FAST_PATTERNS = [
    /^(oi|olá|ola|hey|ei|bom dia|boa tarde|boa noite)\b/i,
    /^(qual|quanto|onde|quando) (é|e|está|esta|fica|tenho|tem|foi|são|sao) /i,
    /^(abra|abrir|feche|fechar|inicie|iniciar|execute|executar|mostre|mostrar|liste|listar)\b/i
];

const DEEP_PATTERNS = [
    { pattern: /\\b(debug|debugue|depure|erro|bug|falha|problema)\\b/i, reason: "investigação de problema técnico" },
    { pattern: /\\b(projete|projetar|planeje|planejar|arquitetura|arquitetar|estruture|estruturar)\\b/i, reason: "planejamento ou arquitetura complexa" },
    { pattern: /\\b(programa[cç][aã]o|implementar|implementa[cç][aã]o|c[oó]digo|typescript|javascript|java|spring|react|node|sql|docker|backend|frontend)\\b/i, reason: "problema técnico que pode exigir resposta detalhada" },
    { pattern: /\\b(passo a passo|passo-a-passo|detalhadamente|em detalhes|com exemplos|exemplos completos)\\b/i, reason: "solicitação explícita de resposta detalhada" }
];

const EXTENDED_PATTERNS = [
    { pattern: /\b(analise|análise|avalie|avaliar|investigue|investigar)\b/i, reason: "pedido explícito de análise" },
    { pattern: /\b(compare|comparar|comparação|comparacao)\b/i, reason: "comparação entre conceitos ou opções" },
    { pattern: /\b(explique|explica|explicar|detalhe|detalhar|aprofund(e|a))\b/i, reason: "pedido de explicação aprofundada" },
    { pattern: /\b(por que|porque|por quê|porquê)\b/i, reason: "pergunta causal" },
    { pattern: /\b(como funciona|como faço|como faco|como implementar)\b/i, reason: "pergunta que normalmente exige raciocínio ou etapas" },
    { pattern: /\b(código|codigo|programa|programação|programacao|typescript|javascript|java|spring|react|node|sql|docker|api|backend|frontend)\b/i, reason: "tema técnico ou de programação" },
    { pattern: /\b(projete|projetar|planeje|planejar|arquitetura|arquitetar|estruture|estruturar)\b/i, reason: "planejamento ou arquitetura" },
    { pattern: /\b(debug|debugue|depure|erro|bug|falha|problema)\b/i, reason: "investigação de problema" },
    { pattern: /\b(passo a passo|passo-a-passo|detalhadamente|em detalhes)\b/i, reason: "solicitação de resposta detalhada" }
];

export function classifyMessage(message: string): RouteDecision {
    const normalized = message.trim();

    if (!normalized) {
        return { mode: "fast", depth: "fast", reason: "mensagem vazia", confidence: 1 };
    }

    const toolPreferred = TOOL_INTENT_PATTERNS.some(pattern =>
        pattern.test(normalized)
    );

    const deepMatch = DEEP_PATTERNS.find(item =>
        item.pattern.test(normalized)
    );

    const extendedMatch = EXTENDED_PATTERNS.find(item =>
        item.pattern.test(normalized)
    );

    if (deepMatch) {
        return {
            mode: "extended",
            depth: "deep",
            reason: deepMatch.reason,
            confidence: 0.9,
            toolPreferred
        };
    }

    if (extendedMatch) {
        return {
            mode: "extended",
            depth: "standard",
            reason: extendedMatch.reason,
            confidence: 0.9,
            toolPreferred
        };
    }

    if (FAST_PATTERNS.some(pattern => pattern.test(normalized))) {
        return {
            mode: "fast",
            depth: "fast",
            reason: "comando ou pergunta curta",
            confidence: 0.85,
            toolPreferred
        };
    }

    const words = normalized.split(/\s+/).filter(Boolean);

    if (words.length >= 45 || normalized.length >= 280) {
        return {
            mode: "extended",
            depth: "standard",
            reason: "mensagem longa",
            confidence: 0.8,
            toolPreferred
        };
    }

    if (words.length <= 12) {
        return {
            mode: "fast",
            depth: "fast",
            reason: "mensagem curta sem sinais de raciocínio estendido",
            confidence: 0.75,
            toolPreferred
        };
    }

    return {
        mode: "fast",
        depth: "fast",
        reason: "modo rápido por padrão; sem sinais fortes de raciocínio estendido",
        confidence: 0.6,
        toolPreferred
    };
}
