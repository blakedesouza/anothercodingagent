import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    TelemetryExporter,
    MetricsAccumulator,
    formatOtlpPayload,
    type TelemetryConfig,
    type AggregateMetrics,
    type OtlpPayload,
} from '../../src/observability/telemetry.js';
import { filterProjectConfig } from '../../src/config/trust-boundary.js';

// --- Helpers ---

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
    return {
        enabled: true,
        endpoint: 'https://otel-collector.example.com/v1/metrics',
        interval: 300,
        ...overrides,
    };
}

function makeMetrics(overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
    const defaults: AggregateMetrics = {
        sessionCount: 5,
        totalTokensIn: 100_000,
        totalTokensOut: 50_000,
        totalCostUsd: 1.23,
        errorsByCode: { 'provider.timeout': 3, 'tool.validation': 1 },
        toolUsageCounts: { read_file: 42, write_file: 10, exec_command: 7 },
        latencyPercentiles: { p50: 150, p95: 800, p99: 1200 },
    };
    return { ...defaults, ...overrides } as AggregateMetrics;
}

const noopScrub = (text: string): string => text;

// --- formatOtlpPayload (pure function) ---

describe('formatOtlpPayload', () => {
    it('produces valid OTLP JSON structure', () => {
        const payload = formatOtlpPayload(makeMetrics());

        expect(payload.resourceMetrics).toHaveLength(1);
        const rm = payload.resourceMetrics[0];
        expect(rm.resource.attributes).toContainEqual({
            key: 'service.name',
            value: { stringValue: 'aca' },
        });

        expect(rm.scopeMetrics).toHaveLength(1);
        const sm = rm.scopeMetrics[0];
        expect(sm.scope.name).toBe('aca');
        expect(sm.scope.version).toBe('0.1.0');

        // 2 gauges (sessions, cost) + 3 latency gauges + 2 sums (tokens) + 1 errors + 1 tools = 9
        expect(sm.metrics).toHaveLength(9);
    });

    it('includes session count and cost as gauges', () => {
        const payload = formatOtlpPayload(makeMetrics({ sessionCount: 12, totalCostUsd: 4.56 }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;

        const sessions = metrics.find((m) => m.name === 'aca.sessions.total') as { gauge: { dataPoints: Array<{ asDouble: number }> } };
        expect(sessions).toBeDefined();
        expect(sessions.gauge.dataPoints[0].asDouble).toBe(12);

        const cost = metrics.find((m) => m.name === 'aca.cost.total_usd') as { gauge: { dataPoints: Array<{ asDouble: number }> } };
        expect(cost).toBeDefined();
        expect(cost.gauge.dataPoints[0].asDouble).toBe(4.56);
    });

    it('includes token counts as cumulative sums with startTimeUnixNano', () => {
        const payload = formatOtlpPayload(makeMetrics({ totalTokensIn: 999, totalTokensOut: 333 }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;

        const tokIn = metrics.find((m) => m.name === 'aca.tokens.input') as { sum: { dataPoints: Array<{ asInt: string; startTimeUnixNano: string }>; aggregationTemporality: number; isMonotonic: boolean } };
        expect(tokIn).toBeDefined();
        expect(tokIn.sum.dataPoints[0].asInt).toBe('999');
        expect(tokIn.sum.dataPoints[0].startTimeUnixNano).toBe('0');
        expect(tokIn.sum.aggregationTemporality).toBe(2); // CUMULATIVE
        expect(tokIn.sum.isMonotonic).toBe(true);

        const tokOut = metrics.find((m) => m.name === 'aca.tokens.output') as { sum: { dataPoints: Array<{ asInt: string }> } };
        expect(tokOut.sum.dataPoints[0].asInt).toBe('333');
    });

    it('includes error counts with code attributes', () => {
        const payload = formatOtlpPayload(makeMetrics({
            errorsByCode: { 'provider.timeout': 3, 'auth.invalid': 1 },
        }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
        const errors = metrics.find((m) => m.name === 'aca.errors') as {
            sum: { dataPoints: Array<{ asInt: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> };
        };

        expect(errors).toBeDefined();
        expect(errors.sum.dataPoints).toHaveLength(2);
        const codes = errors.sum.dataPoints.map(
            (dp) => dp.attributes![0].value.stringValue,
        );
        expect(codes).toContain('provider.timeout');
        expect(codes).toContain('auth.invalid');
    });

    it('includes tool usage counts with tool name attributes', () => {
        const payload = formatOtlpPayload(makeMetrics({
            toolUsageCounts: { read_file: 42, write_file: 10 },
        }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
        const tools = metrics.find((m) => m.name === 'aca.tools.usage') as {
            sum: { dataPoints: Array<{ asInt: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> };
        };

        expect(tools).toBeDefined();
        expect(tools.sum.dataPoints).toHaveLength(2);
        const names = tools.sum.dataPoints.map(
            (dp) => dp.attributes![0].value.stringValue,
        );
        expect(names).toContain('read_file');
        expect(names).toContain('write_file');
    });

    it('omits errors metric when no errors', () => {
        const payload = formatOtlpPayload(makeMetrics({ errorsByCode: {} }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
        expect(metrics.find((m) => m.name === 'aca.errors')).toBeUndefined();
    });

    it('omits tools metric when no tool usage', () => {
        const payload = formatOtlpPayload(makeMetrics({ toolUsageCounts: {} }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
        expect(metrics.find((m) => m.name === 'aca.tools.usage')).toBeUndefined();
    });

    it('contains no conversation content, tool args, file paths, or messages', () => {
        const payload = formatOtlpPayload(makeMetrics());
        const json = JSON.stringify(payload);

        // Only expected strings in the payload
        const allowedStrings = [
            'resourceMetrics', 'resource', 'attributes', 'key', 'value',
            'stringValue', 'scopeMetrics', 'scope', 'name', 'version',
            'metrics', 'gauge', 'dataPoints', 'asDouble', 'asInt',
            'startTimeUnixNano', 'timeUnixNano',
            'sum', 'aggregationTemporality', 'isMonotonic',
            'service.name', 'aca', '0.1.0',
            'aca.sessions.total', 'aca.cost.total_usd',
            'aca.latency.p50_ms', 'aca.latency.p95_ms', 'aca.latency.p99_ms',
            'aca.tokens.input', 'aca.tokens.output',
            'aca.errors', 'aca.tools.usage',
            'error.code', 'tool.name',
            // Error codes and tool names (our internal identifiers, not user content)
            'provider.timeout', 'tool.validation',
            'read_file', 'write_file', 'exec_command',
        ];

        // Extract all string values from the JSON
        const stringValues: string[] = [];
        JSON.parse(json, (_key, val) => {
            if (typeof val === 'string') stringValues.push(val);
            return val;
        });

        // Every string in the payload must be either a known field name,
        // a number-as-string (timeUnixNano, asInt), or an allowed identifier
        for (const s of stringValues) {
            const isAllowed =
                allowedStrings.includes(s) ||
                /^\d+$/.test(s); // timestamps and integer-as-string values
            expect(isAllowed, `Unexpected string in telemetry payload: "${s}"`).toBe(true);
        }
    });
});

// --- TelemetryExporter ---

describe('TelemetryExporter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('telemetry.enabled: false → no export attempted', () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        const exporter = new TelemetryExporter(
            makeConfig({ enabled: false }),
            collector,
            noopScrub,
        );

        exporter.start();
        expect(exporter.isRunning()).toBe(false);
        expect(collector).not.toHaveBeenCalled();
        exporter.stop();
    });

    it('no endpoint → no export attempted', () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        const exporter = new TelemetryExporter(
            makeConfig({ enabled: true, endpoint: '' }),
            collector,
            noopScrub,
        );

        exporter.start();
        expect(exporter.isRunning()).toBe(false);
        exporter.stop();
    });

    it('enabled with endpoint → starts interval and exports at configured interval', async () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ enabled: true, interval: 60 }),
            collector,
            noopScrub,
        );

        exporter.start();
        expect(exporter.isRunning()).toBe(true);

        // No export immediately
        expect(fetchSpy).not.toHaveBeenCalled();

        // Advance to first interval
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(collector).toHaveBeenCalledTimes(1);

        // Verify fetch was called with the right endpoint and method
        const [url, opts] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://otel-collector.example.com/v1/metrics');
        expect((opts as RequestInit).method).toBe('POST');
        expect((opts as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' });

        // Verify payload is valid OTLP JSON
        const body = JSON.parse((opts as RequestInit).body as string) as OtlpPayload;
        expect(body.resourceMetrics).toHaveLength(1);

        exporter.stop();
        expect(exporter.isRunning()).toBe(false);
    });

    it('aggregate metrics sent at interval — verify payload content', async () => {
        const metrics = makeMetrics({
            sessionCount: 3,
            totalTokensIn: 50_000,
            totalTokensOut: 25_000,
            totalCostUsd: 0.75,
        });
        const collector = vi.fn().mockReturnValue(metrics);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ interval: 300 }),
            collector,
            noopScrub,
        );

        exporter.start();
        await vi.advanceTimersByTimeAsync(300_000);

        const body = JSON.parse(
            (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
        ) as OtlpPayload;
        const otlpMetrics = body.resourceMetrics[0].scopeMetrics[0].metrics;

        // Verify session count gauge
        const sessions = otlpMetrics.find((m) => m.name === 'aca.sessions.total') as {
            gauge: { dataPoints: Array<{ asDouble: number }> };
        };
        expect(sessions.gauge.dataPoints[0].asDouble).toBe(3);

        exporter.stop();
    });

    it('unreachable endpoint → no error, agent continues normally', async () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            new Error('connect ECONNREFUSED'),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ interval: 10 }),
            collector,
            noopScrub,
        );

        exporter.start();

        // Should not throw despite fetch failure
        await vi.advanceTimersByTimeAsync(10_000);

        // Exporter still running (not crashed)
        expect(exporter.isRunning()).toBe(true);

        // Second interval also works fine
        await vi.advanceTimersByTimeAsync(10_000);
        expect(exporter.isRunning()).toBe(true);

        exporter.stop();
    });

    it('collector error → silently swallowed', async () => {
        const collector = vi.fn().mockImplementation(() => {
            throw new Error('SQLite read failed');
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ interval: 10 }),
            collector,
            noopScrub,
        );

        exporter.start();
        await vi.advanceTimersByTimeAsync(10_000);

        // No crash, still running
        expect(exporter.isRunning()).toBe(true);
        exporter.stop();
    });

    it('scrub function is called on metric strings before serialization', async () => {
        const metrics = makeMetrics({
            errorsByCode: { 'secret.leak': 2 },
            toolUsageCounts: { sensitive_tool: 5 },
        });
        const collector = vi.fn().mockReturnValue(metrics);
        const scrubFn = vi.fn((text: string) => text.replace(/secret/g, 'REDACTED').replace(/sensitive/g, 'CLEAN'));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ interval: 10 }),
            collector,
            scrubFn,
        );

        exporter.start();
        await vi.advanceTimersByTimeAsync(10_000);

        // Scrub was called on error codes and tool names (pre-serialization)
        expect(scrubFn).toHaveBeenCalled();
        const sentBody = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
        // Verify scrubbed values appear in sent payload
        expect(sentBody).toContain('REDACTED.leak');
        expect(sentBody).toContain('CLEAN_tool');
        // Original values should not appear
        expect(sentBody).not.toContain('secret.leak');
        expect(sentBody).not.toContain('sensitive_tool');
        // JSON structure should be valid (not corrupted by scrubbing)
        expect(() => JSON.parse(sentBody)).not.toThrow();

        exporter.stop();
    });

    it('double start() does not create multiple intervals', async () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ interval: 10 }),
            collector,
            noopScrub,
        );

        exporter.start();
        exporter.start(); // Second call — should be no-op

        await vi.advanceTimersByTimeAsync(30_000);
        // 3 intervals at 10s each = 3 exports (not 6 from double timer)
        expect(fetchSpy).toHaveBeenCalledTimes(3);

        exporter.stop();
    });

    it('stop() clears the interval', async () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig({ interval: 10 }),
            collector,
            noopScrub,
        );

        exporter.start();
        exporter.stop();

        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('exportOnce() can be called directly', async () => {
        const collector = vi.fn().mockReturnValue(makeMetrics());
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 200 }),
        );

        const exporter = new TelemetryExporter(
            makeConfig(),
            collector,
            noopScrub,
        );

        await exporter.exportOnce();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(collector).toHaveBeenCalledTimes(1);
    });
});

// --- MetricsAccumulator ---

describe('MetricsAccumulator', () => {
    it('snapshot returns zeros when nothing recorded', () => {
        const acc = new MetricsAccumulator();
        const snap = acc.snapshot();

        expect(snap.sessionCount).toBe(1);
        expect(snap.totalTokensIn).toBe(0);
        expect(snap.totalTokensOut).toBe(0);
        expect(snap.totalCostUsd).toBe(0);
        expect(snap.errorsByCode).toEqual({});
        expect(snap.toolUsageCounts).toEqual({});
        expect(snap.latencyPercentiles).toEqual({ p50: 0, p95: 0, p99: 0 });
    });

    it('recordLlmResponse accumulates tokens, cost, and latency', () => {
        const acc = new MetricsAccumulator();
        acc.recordLlmResponse(1000, 500, 0.05, 200);
        acc.recordLlmResponse(2000, 800, 0.10, 400);

        const snap = acc.snapshot();
        expect(snap.totalTokensIn).toBe(3000);
        expect(snap.totalTokensOut).toBe(1300);
        expect(snap.totalCostUsd).toBeCloseTo(0.15);
        expect(snap.latencyPercentiles.p50).toBeGreaterThan(0);
    });

    it('recordLlmResponse ignores null cost, non-finite latency, and NaN tokens', () => {
        const acc = new MetricsAccumulator();
        acc.recordLlmResponse(NaN, 50, null, NaN);
        acc.recordLlmResponse(100, NaN, null, -1);
        acc.recordLlmResponse(100, 50, Infinity, Infinity);

        const snap = acc.snapshot();
        // NaN tokens are skipped; only finite values accumulated
        expect(snap.totalTokensIn).toBe(200);   // 100 + 100, NaN skipped
        expect(snap.totalTokensOut).toBe(100);   // 50 + 50, NaN skipped
        expect(snap.totalCostUsd).toBe(0);
        expect(snap.latencyPercentiles).toEqual({ p50: 0, p95: 0, p99: 0 });
    });

    it('recordToolCall counts per tool name', () => {
        const acc = new MetricsAccumulator();
        acc.recordToolCall('read_file');
        acc.recordToolCall('read_file');
        acc.recordToolCall('write_file');

        const snap = acc.snapshot();
        expect(snap.toolUsageCounts).toEqual({ read_file: 2, write_file: 1 });
    });

    it('recordError counts per error code', () => {
        const acc = new MetricsAccumulator();
        acc.recordError('tool.validation');
        acc.recordError('tool.validation');
        acc.recordError('llm.timeout');

        const snap = acc.snapshot();
        expect(snap.errorsByCode).toEqual({ 'tool.validation': 2, 'llm.timeout': 1 });
    });

    it('snapshot returns a copy — mutations do not affect accumulator', () => {
        const acc = new MetricsAccumulator();
        acc.recordToolCall('read_file');
        const snap1 = acc.snapshot();
        snap1.toolUsageCounts['read_file'] = 999;

        const snap2 = acc.snapshot();
        expect(snap2.toolUsageCounts['read_file']).toBe(1);
    });

    it('latency percentiles computed correctly for multiple values', () => {
        const acc = new MetricsAccumulator();
        // Record 100 values: 1ms, 2ms, ..., 100ms
        for (let i = 1; i <= 100; i++) {
            acc.recordLlmResponse(0, 0, null, i);
        }

        const snap = acc.snapshot();
        expect(snap.latencyPercentiles.p50).toBe(50);
        expect(snap.latencyPercentiles.p95).toBe(95);
        expect(snap.latencyPercentiles.p99).toBe(99);
    });

    it('latency array caps at 10,000 entries (drops oldest)', () => {
        const acc = new MetricsAccumulator();
        // Fill past cap
        for (let i = 1; i <= 10_001; i++) {
            acc.recordLlmResponse(0, 0, null, i);
        }

        const snap = acc.snapshot();
        // p50 should reflect recent values (entries 2-10001), not entry 1
        // With 10000 values from 2..10001, p50 = ~5001
        expect(snap.latencyPercentiles.p50).toBeGreaterThan(1);
        // p99 should be near 10001
        expect(snap.latencyPercentiles.p99).toBeGreaterThanOrEqual(9900);
    });

    it('latency percentiles with single value', () => {
        const acc = new MetricsAccumulator();
        acc.recordLlmResponse(0, 0, null, 250);

        const snap = acc.snapshot();
        expect(snap.latencyPercentiles.p50).toBe(250);
        expect(snap.latencyPercentiles.p95).toBe(250);
        expect(snap.latencyPercentiles.p99).toBe(250);
    });
});

// --- Latency gauges in OTLP payload ---

describe('formatOtlpPayload latency metrics', () => {
    it('includes latency percentile gauges', () => {
        const payload = formatOtlpPayload(makeMetrics({
            latencyPercentiles: { p50: 150, p95: 800, p99: 1200 },
        }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;

        const p50 = metrics.find((m) => m.name === 'aca.latency.p50_ms') as {
            gauge: { dataPoints: Array<{ asDouble: number }> };
        };
        expect(p50).toBeDefined();
        expect(p50.gauge.dataPoints[0].asDouble).toBe(150);

        const p95 = metrics.find((m) => m.name === 'aca.latency.p95_ms') as {
            gauge: { dataPoints: Array<{ asDouble: number }> };
        };
        expect(p95).toBeDefined();
        expect(p95.gauge.dataPoints[0].asDouble).toBe(800);

        const p99 = metrics.find((m) => m.name === 'aca.latency.p99_ms') as {
            gauge: { dataPoints: Array<{ asDouble: number }> };
        };
        expect(p99).toBeDefined();
        expect(p99.gauge.dataPoints[0].asDouble).toBe(1200);
    });

    it('zero latency percentiles still produce gauges', () => {
        const payload = formatOtlpPayload(makeMetrics({
            latencyPercentiles: { p50: 0, p95: 0, p99: 0 },
        }));
        const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;

        const p50 = metrics.find((m) => m.name === 'aca.latency.p50_ms') as {
            gauge: { dataPoints: Array<{ asDouble: number }> };
        };
        expect(p50).toBeDefined();
        expect(p50.gauge.dataPoints[0].asDouble).toBe(0);
    });
});

// --- Trust boundary (project config cannot enable telemetry) ---

describe('Telemetry trust boundary', () => {
    it('project config sets telemetry.enabled: true → rejected (user-only)', () => {
        const filtered = filterProjectConfig({
            telemetry: { enabled: true, endpoint: 'http://evil.com', interval: 10 },
        });

        // telemetry is entirely user-only — silently dropped
        expect((filtered as Record<string, unknown>).telemetry).toBeUndefined();
    });

    it('project config sets telemetry alongside allowed fields → telemetry dropped, others kept', () => {
        const filtered = filterProjectConfig({
            model: { default: 'gpt-4' },
            telemetry: { enabled: true, endpoint: 'http://evil.com' },
            project: { conventions: 'Use tabs' },
        });

        expect((filtered as Record<string, unknown>).telemetry).toBeUndefined();
        expect((filtered as Record<string, unknown>).model).toEqual({ default: 'gpt-4' });
        expect((filtered as Record<string, unknown>).project).toEqual({ conventions: 'Use tabs' });
    });
});
