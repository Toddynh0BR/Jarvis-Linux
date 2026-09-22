export interface ModelMetrics {
    durationMs: number;
    loadDurationMs: number;
    promptTokens: number;
    cachedPromptTokens: number;
    promptEvalDurationMs: number;
    outputTokens: number;
    outputDurationMs: number;
    tokensPerSecond: number;
}

export interface RequestMetrics {
    mode: "fast" | "extended";
    totalDurationMs: number;
    modelCalls: number;
    toolCalls: number;
    modelMetrics: ModelMetrics[];
}

export class PerformanceTracker {
    private readonly startedAt = performance.now();
    private readonly modelMetrics: ModelMetrics[] = [];
    private toolCalls = 0;

    recordToolCall(): void {
        this.toolCalls++;
    }

    recordModelResponse(response: {
        total_duration?: number;
        load_duration?: number;
        prompt_eval_count?: number;
        prompt_eval_cached_count?: number;
        prompt_eval_duration?: number;
        eval_count?: number;
        eval_duration?: number;
    }): void {
        const totalDurationMs = (response.total_duration ?? 0) / 1_000_000;
        const loadDurationMs = (response.load_duration ?? 0) / 1_000_000;
        const promptEvalDurationMs = (response.prompt_eval_duration ?? 0) / 1_000_000;
        const outputDurationMs = (response.eval_duration ?? 0) / 1_000_000;
        const outputTokens = response.eval_count ?? 0;

        this.modelMetrics.push({
            durationMs: totalDurationMs,
            loadDurationMs,
            promptTokens: response.prompt_eval_count ?? 0,
            cachedPromptTokens: response.prompt_eval_cached_count ?? 0,
            promptEvalDurationMs,
            outputTokens,
            outputDurationMs,
            tokensPerSecond:
                outputDurationMs > 0
                    ? outputTokens / (outputDurationMs / 1000)
                    : 0
        });
    }

    snapshot(mode: "fast" | "extended"): RequestMetrics {
        return {
            mode,
            totalDurationMs: performance.now() - this.startedAt,
            modelCalls: this.modelMetrics.length,
            toolCalls: this.toolCalls,
            modelMetrics: [...this.modelMetrics]
        };
    }
}

export function formatPerformance(metrics: RequestMetrics): string {
    const total = (metrics.totalDurationMs / 1000).toFixed(2) + "s";

    const model = metrics.modelMetrics
        .map(item => {
            const speed =
                item.tokensPerSecond > 0
                    ? ", " + item.tokensPerSecond.toFixed(1) + " tok/s"
                    : "";

            return (
                (item.durationMs / 1000).toFixed(2) +
                "s, load " +
                (item.loadDurationMs / 1000).toFixed(2) +
                "s, prompt " +
                item.promptTokens +
                " tok, output " +
                item.outputTokens +
                " tok" +
                speed
            );
        })
        .join(" | ");

    return "[Performance] " +
        metrics.mode +
        " | total " +
        total +
        " | model calls " +
        metrics.modelCalls +
        " | tools " +
        metrics.toolCalls +
        (model ? " | model: " + model : "");
}
