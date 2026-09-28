export type DirectToolIntent =
    | {
        type: "systemStatus";
        toolName: "getSystemStatus";
        args: Record<string, never>;
      }
    | {
        type: "openUrl";
        toolName: "openUrl";
        args: { url: string };
      }
    | {
        type: "forgetMemory";
        toolName: "forgetMemory";
        args: { key: string };
      };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

const SYSTEM_STATUS_PATTERNS = [
    /\b(meu|minha|meus|minhas)\s+(sistema|processador|cpu|ram|mem[oó]ria|gpu|placa de v[ií]deo|kernel)\b/i,
    /\b(sistema operacional|informa[cç][oõ]es do sistema|status do sistema)\b/i,
    /\b(mostre|mostrar|ver|veja)\s+(as?\s+)?informa[cç][oõ]es\s+(do|sobre o)\s+(meu\s+)?sistema\b/i
];

const OPEN_URL_PATTERNS = [
    /\b(abra|abrir|acesse|acessar|visite|visitar)\b/i
];

const FORGET_MEMORY_PATTERNS = [
    /\besque[cç]a(?:\s+o)?\s+(?:meu|minha)\s+nome\b/i,
    /\b(?:apague|remova|delete)\s+(?:o|a)?\s*(?:meu|minha)\s+nome\b/i
];

export function resolveDirectToolIntent(message: string): DirectToolIntent | null {
    const normalized = message.trim();

    if (!normalized) {
        return null;
    }

    const urlMatch = normalized.match(URL_PATTERN);

    if (
        urlMatch &&
        OPEN_URL_PATTERNS.some(pattern => pattern.test(normalized))
    ) {
        return {
            type: "openUrl",
            toolName: "openUrl",
            args: { url: urlMatch[0].replace(/[),.!?]+$/, "") }
        };
    }

    if (SYSTEM_STATUS_PATTERNS.some(pattern => pattern.test(normalized))) {
        return {
            type: "systemStatus",
            toolName: "getSystemStatus",
            args: {}
        };
    }

    if (FORGET_MEMORY_PATTERNS.some(pattern => pattern.test(normalized))) {
        return {
            type: "forgetMemory",
            toolName: "forgetMemory",
            args: { key: "user.name" }
        };
    }

    return null;
}
