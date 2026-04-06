/**
 * Remote Telemetry (Block 19, M5.7) — opt-in aggregate metrics export.
 *
 * Exports numeric aggregate metrics only via OTLP/HTTP JSON format.
 * Never exports: conversation content, tool arguments/results, file paths,
 * user/assistant messages, error details.
 *
 * Uses Node's built-in fetch() to POST OTLP-formatted JSON directly,
 * following the OTLP/HTTP specification. This avoids pulling in
 * @opentelemetry/sdk-metrics (unlisted transitive dependency required
 * by @opentelemetry/exporter-metrics-otlp-http) for 6 numeric metrics.
 */

// --- Config ---

export interface TelemetryConfig {
    enabled: boolean;
    endpoint: string;
    interval: number; // seconds
}

// --- Aggregate metrics (only numeric values, no user content) ---

export interface LatencyPercentiles {
    p50: number;
    p95: number;
    p99: number;
}

export interface AggregateMetrics {
    sessionCount: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCostUsd: number;
    errorsByCode: Record<string, number>;
    toolUsageCounts: Record<string, number>;
    latencyPercentiles: LatencyPercentiles;
}

// --- Collector and scrub function types ---

export type MetricCollector = () => AggregateMetrics;
export type ScrubFn = (text: string) => string;

// --- MetricsAccumulator ---

/**
 * In-memory accumulator for session metrics.
 * Called from TurnEngine to record LLM responses, tool calls, and errors.
 * The snapshot() method produces the AggregateMetrics for OTLP export.
 */
/** Max latency samples retained. 10,000 covers ~10K LLM calls — well beyond typical sessions. */
const MAX_LATENCY_SAMPLES = 10_000;

export class MetricsAccumulator {
    private totalTokensIn = 0;
    private totalTokensOut = 0;
    private totalCostUsd = 0;
    private readonly errors: Record<string, number> = {};
    private readonly tools: Record<string, number> = {};
    private readonly latencies: number[] = [];

    recordLlmResponse(tokensIn: number, tokensOut: number, costUsd: number | null, latencyMs: number): void {
        if (Number.isFinite(tokensIn)) this.totalTokensIn += tokensIn;
        if (Number.isFinite(tokensOut)) this.totalTokensOut += tokensOut;
        if (costUsd !== null && Number.isFinite(costUsd)) {
            this.totalCostUsd += costUsd;
        }
        if (Number.isFinite(latencyMs) && latencyMs >= 0) {
            if (this.latencies.length >= MAX_LATENCY_SAMPLES) {
                this.latencies.shift(); // Drop oldest sample
            }
            this.latencies.push(latencyMs);
        }
    }

    recordToolCall(toolName: string): void {
        this.tools[toolName] = (this.tools[toolName] ?? 0) + 1;
    }

    recordError(code: string): void {
        this.errors[code] = (this.errors[code] ?? 0) + 1;
    }

    snapshot(): AggregateMetrics {
        return {
            sessionCount: 1,
            totalTokensIn: this.totalTokensIn,
            totalTokensOut: this.totalTokensOut,
            totalCostUsd: this.totalCostUsd,
            errorsByCode: { ...this.errors },
            toolUsageCounts: { ...this.tools },
            latencyPercentiles: computePercentiles(this.latencies),
        };
    }
}

/** Compute p50/p95/p99 from an array of latency values. */
function computePercentiles(values: number[]): LatencyPercentiles {
    if (values.length === 0) {
        return { p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    return {
        p50: percentile(sorted, 0.50),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
    };
}

/** Nearest-rank percentile from a pre-sorted array. */
function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
}

// --- TelemetryExporter ---

export class TelemetryExporter {
    private timer: ReturnType<typeof setInterval> | null = null;
    private exporting = false;

    constructor(
        private readonly config: TelemetryConfig,
        private readonly collect: MetricCollector,
        private readonly scrub: ScrubFn,
    ) {}

    /**
     * Start periodic export. No-op if telemetry is disabled or no endpoint.
     * Idempotent — calling start() twice does not create multiple timers.
     */
    start(): void {
        if (!this.config.enabled || !this.config.endpoint) return;
        if (this.timer !== null) return; // Guard against double-start
        this.timer = setInterval(() => {
            if (this.exporting) return; // Skip if previous export still in-flight
            this.exporting = true;
            this.exportOnce().finally(() => { this.exporting = false; });
        }, this.config.interval * 1000);
        // Don't prevent Node from exiting
        if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
            (this.timer as NodeJS.Timeout).unref();
        }
    }

    /**
     * Stop periodic export and clear the interval.
     */
    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Whether the exporter is currently running.
     */
    isRunning(): boolean {
        return this.timer !== null;
    }

    /**
     * Collect metrics, format as OTLP JSON, POST to configured endpoint.
     * Errors are silently swallowed — telemetry failure never affects the agent.
     */
    async exportOnce(): Promise<void> {
        try {
            const metrics = this.collect();

            // Scrub string keys in the metrics (error codes, tool names) before
            // formatting into OTLP JSON. This prevents JSON structure corruption
            // that would occur if scrubbing ran on serialized JSON.
            const scrubbed = scrubMetricStrings(metrics, this.scrub);
            const payload = formatOtlpPayload(scrubbed);

            await fetch(this.config.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            // Silently drop — telemetry failure never affects agent operation
        }
    }
}

// --- Pre-serialization scrubbing ---

/**
 * Scrub string keys in the aggregate metrics (error codes, tool names)
 * before OTLP formatting. This targets user-influenced strings without
 * risking corruption of JSON structure.
 */
function scrubMetricStrings(metrics: AggregateMetrics, scrub: ScrubFn): AggregateMetrics {
    return {
        ...metrics,
        errorsByCode: Object.fromEntries(
            Object.entries(metrics.errorsByCode).map(([code, count]) => [scrub(code), count]),
        ),
        toolUsageCounts: Object.fromEntries(
            Object.entries(metrics.toolUsageCounts).map(([tool, count]) => [scrub(tool), count]),
        ),
    };
}

// --- OTLP JSON types (subset of ExportMetricsServiceRequest) ---

interface OtlpAttribute {
    key: string;
    value: { stringValue: string };
}

interface OtlpDataPoint {
    asDouble?: number;
    asInt?: string;
    startTimeUnixNano?: string;
    timeUnixNano: string;
    attributes?: OtlpAttribute[];
}

interface OtlpGaugeMetric {
    name: string;
    gauge: { dataPoints: OtlpDataPoint[] };
}

interface OtlpSumMetric {
    name: string;
    sum: {
        dataPoints: OtlpDataPoint[];
        aggregationTemporality: number; // 2 = CUMULATIVE
        isMonotonic: boolean;
    };
}

type OtlpMetric = OtlpGaugeMetric | OtlpSumMetric;

export interface OtlpPayload {
    resourceMetrics: Array<{
        resource: { attributes: OtlpAttribute[] };
        scopeMetrics: Array<{
            scope: { name: string; version: string };
            metrics: OtlpMetric[];
        }>;
    }>;
}

// --- OTLP formatting ---

/**
 * Format aggregate metrics as an OTLP/HTTP JSON payload.
 * Only includes numeric values — no user content, file paths, or messages.
 */
export function formatOtlpPayload(metrics: AggregateMetrics): OtlpPayload {
    const nowNano = (BigInt(Date.now()) * 1_000_000n).toString();
    const otlpMetrics: OtlpMetric[] = [];

    // Gauge metrics (point-in-time snapshot values)
    otlpMetrics.push(makeGauge('aca.sessions.total', safe(metrics.sessionCount), nowNano));
    otlpMetrics.push(makeGauge('aca.cost.total_usd', safe(metrics.totalCostUsd), nowNano));

    // Latency percentile gauges (point-in-time snapshot)
    otlpMetrics.push(makeGauge('aca.latency.p50_ms', safe(metrics.latencyPercentiles.p50), nowNano));
    otlpMetrics.push(makeGauge('aca.latency.p95_ms', safe(metrics.latencyPercentiles.p95), nowNano));
    otlpMetrics.push(makeGauge('aca.latency.p99_ms', safe(metrics.latencyPercentiles.p99), nowNano));

    // Cumulative sum metrics (startTimeUnixNano = "0" means unknown start)
    otlpMetrics.push(makeSum('aca.tokens.input', metrics.totalTokensIn, nowNano));
    otlpMetrics.push(makeSum('aca.tokens.output', metrics.totalTokensOut, nowNano));

    // Error counts by code (one data point per error code)
    const errorPoints: OtlpDataPoint[] = Object.entries(metrics.errorsByCode).map(
        ([code, count]) => ({
            asInt: String(safeInt(count)),
            startTimeUnixNano: '0',
            timeUnixNano: nowNano,
            attributes: [{ key: 'error.code', value: { stringValue: code } }],
        }),
    );
    if (errorPoints.length > 0) {
        otlpMetrics.push({
            name: 'aca.errors',
            sum: { dataPoints: errorPoints, aggregationTemporality: 2, isMonotonic: true },
        });
    }

    // Tool usage counts (one data point per tool name)
    const toolPoints: OtlpDataPoint[] = Object.entries(metrics.toolUsageCounts).map(
        ([tool, count]) => ({
            asInt: String(safeInt(count)),
            startTimeUnixNano: '0',
            timeUnixNano: nowNano,
            attributes: [{ key: 'tool.name', value: { stringValue: tool } }],
        }),
    );
    if (toolPoints.length > 0) {
        otlpMetrics.push({
            name: 'aca.tools.usage',
            sum: { dataPoints: toolPoints, aggregationTemporality: 2, isMonotonic: true },
        });
    }

    return {
        resourceMetrics: [{
            resource: {
                attributes: [
                    { key: 'service.name', value: { stringValue: 'aca' } },
                ],
            },
            scopeMetrics: [{
                scope: { name: 'aca', version: '0.1.0' },
                metrics: otlpMetrics,
            }],
        }],
    };
}

/** Clamp NaN/Infinity to 0 for safe OTLP export. */
function safe(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

/** Integer-safe variant: clamp then floor. */
function safeInt(value: number): number {
    return Number.isFinite(value) ? Math.floor(value) : 0;
}

function makeGauge(name: string, value: number, nowNano: string): OtlpGaugeMetric {
    return {
        name,
        gauge: {
            dataPoints: [{ asDouble: value, timeUnixNano: nowNano }],
        },
    };
}

function makeSum(name: string, value: number, nowNano: string): OtlpSumMetric {
    return {
        name,
        sum: {
            dataPoints: [{
                asInt: String(safeInt(value)),
                startTimeUnixNano: '0', // Unknown start — cumulative from process lifetime
                timeUnixNano: nowNano,
            }],
            aggregationTemporality: 2, // CUMULATIVE
            isMonotonic: true,
        },
    };
}
