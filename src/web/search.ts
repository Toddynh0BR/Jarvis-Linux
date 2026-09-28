export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface WebSearchResponse {
    query: string;
    retrievedAt: string;
    results: WebSearchResult[];
}

const SEARCH_ENDPOINT =
    "https://html.duckduckgo.com/html/";

export async function searchWeb(
    query: string,
    limit = 5
): Promise<WebSearchResponse> {
    const cleanQuery = query.trim();

    if (!cleanQuery) {
        throw new Error(
            "A consulta de pesquisa não pode estar vazia."
        );
    }

    const response = await fetch(
        SEARCH_ENDPOINT +
        "?q=" +
        encodeURIComponent(cleanQuery),
        {
            headers: {
                "user-agent": "Jarvis-Linux/0.4"
            },
            signal: AbortSignal.timeout(10000)
        }
    );

    if (!response.ok) {
        throw new Error(
            "O mecanismo de pesquisa respondeu com HTTP " +
            String(response.status) +
            "."
        );
    }

    const html = await response.text();
    const results = parseResults(html).slice(
        0,
        Math.max(1, Math.min(limit, 8))
    );

    if (!results.length) {
        throw new Error(
            "A pesquisa não retornou resultados utilizáveis."
        );
    }

    return {
        query: cleanQuery,
        retrievedAt: new Date().toISOString(),
        results
    };
}

function parseResults(
    html: string
): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    const blocks = html.split(
        /<div[^>]+class="[^"]*result[^"]*"[^>]*>/i
    );

    for (const block of blocks.slice(1)) {
        const linkMatch = block.match(
            /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
        );

        if (!linkMatch) continue;

        const snippetMatch =
            block.match(
                /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>[\s\S]*?<\/a>/i
            ) ??
            block.match(
                /<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i
            );

        const url = decodeHtml(linkMatch[1]);

        if (!/^https?:\/\//i.test(url)) continue;

        results.push({
            title: stripHtml(linkMatch[2]),
            url,
            snippet: stripHtml(
                snippetMatch?.[1] ??
                snippetMatch?.[0] ??
                ""
            )
        });
    }

    return results;
}

function stripHtml(value: string): string {
    return decodeHtml(
        value
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

function decodeHtml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x27;/gi, "'");
}
