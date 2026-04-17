#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const HOST = process.env.ACA_DEBUG_UI_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.ACA_DEBUG_UI_PORT || '4777', 10);
const TOKEN = process.env.ACA_DEBUG_UI_TOKEN || randomBytes(18).toString('base64url');
const ACA_HOME = process.env.ACA_HOME || join(homedir(), '.aca');
const DB_PATH = process.env.ACA_OBSERVABILITY_DB || join(ACA_HOME, 'observability.db');
const SESSIONS_DIR = process.env.ACA_SESSIONS_DIR || join(ACA_HOME, 'sessions');
const CONSULT_TMP_DIR = process.env.ACA_CONSULT_TMP_DIR || tmpdir();
const METADATA_PATH = process.env.ACA_DEBUG_UI_METADATA_PATH || join(ACA_HOME, 'debug-ui.json');
const MAX_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 96 * 1024;
const SEEDED_WITNESSES = parseWitnessSeed(process.env.ACA_DEBUG_UI_WITNESS_SEED || '');
const APP_HTML_URL = new URL('./aca-debug-ui-app.html', import.meta.url);

let db = null;
if (existsSync(DB_PATH)) {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    sendJson(res, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${encodeURIComponent(TOKEN)}`;
  writeMetadata(url);
  process.stderr.write('\nACA local debug UI\n');
  process.stderr.write(`URL: ${url}\n`);
  process.stderr.write(`Host: ${HOST} (${hostname()})\n`);
  process.stderr.write(`DB:   ${DB_PATH}${db ? '' : ' (not found yet)'}\n`);
  process.stderr.write(`Logs: ${SESSIONS_DIR}\n`);
  process.stderr.write('Security: bound to loopback and protected by a per-process token.\n\n');
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function writeMetadata(url) {
  try {
    mkdirSync(dirname(METADATA_PATH), { recursive: true });
    writeFileSync(METADATA_PATH, JSON.stringify({
      version: 1,
      host: HOST,
      port: PORT,
      token: TOKEN,
      pid: process.pid,
      url,
      acaHome: ACA_HOME,
      metadataPath: METADATA_PATH,
      startedAt: new Date().toISOString(),
    }, null, 2));
  } catch {
    // best effort
  }
}

function removeMetadata() {
  try {
    if (!existsSync(METADATA_PATH)) return;
    const parsed = JSON.parse(readFileSync(METADATA_PATH, 'utf-8'));
    if (parsed?.pid === process.pid) {
      rmSync(METADATA_PATH, { force: true });
    }
  } catch {
    // best effort
  }
}

function shutdown(code) {
  removeMetadata();
  try {
    db?.close();
  } catch {
    // best effort
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 750).unref();
}

function parseWitnessSeed(raw) {
  return [...new Set(String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))];
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  if (!isLocalHostHeader(req.headers.host)) {
    sendJson(res, 403, { error: 'forbidden_host', message: 'Only localhost host headers are accepted.' });
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, db: Boolean(db), sessionsDir: existsSync(SESSIONS_DIR) });
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (!isAuthorized(req, url)) {
    sendHtml(res, 401, loginHtml());
    return;
  }

  if (url.pathname === '/') {
    sendHtml(res, 200, appHtml());
    return;
  }

  if (url.pathname === '/api/control/shutdown') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    sendJson(res, 200, { ok: true, shuttingDown: true });
    setTimeout(() => shutdown(0), 50).unref();
    return;
  }

  if (url.pathname === '/api/overview') {
    sendJson(res, 200, overview());
    return;
  }

  if (url.pathname === '/api/sessions') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 250, 50);
    sendJson(res, 200, { sessions: listSessions(limit) });
    return;
  }

  if (url.pathname === '/api/consults') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 25);
    const since = url.searchParams.get('since') || null;
    sendJson(res, 200, { consults: listConsults(limit, since) });
    return;
  }

  const consultMatch = url.pathname.match(/^\/api\/consults\/(.+)$/);
  if (consultMatch) {
    const suffix = consultMatch[1];
    if (!isConsultSuffix(suffix)) {
      sendJson(res, 400, { error: 'invalid_consult_suffix' });
      return;
    }
    sendJson(res, 200, consultDetail(suffix));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const child = sessionMatch[2] || 'detail';
    if (!isSessionId(sessionId)) {
      sendJson(res, 400, { error: 'invalid_session_id' });
      return;
    }

    if (child === 'detail') {
      sendJson(res, 200, sessionDetail(sessionId));
      return;
    }
    if (child === 'events') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 300);
      sendJson(res, 200, { events: readSessionJsonl(sessionId, 'events.jsonl', limit) });
      return;
    }
    if (child === 'conversation') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 250);
      sendJson(res, 200, { records: readSessionJsonl(sessionId, 'conversation.jsonl', limit) });
      return;
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

function overview() {
  const sessions = listSessions(5000);
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lastDay = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const last7DaysSessions = sessions.filter((session) => String(session.startedAt || '') >= sevenDaysAgo).length;

  const aggregate = dbQueryOne(
    `SELECT
       COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS totalCost,
       COALESCE(SUM(json_extract(payload, '$.tokens_in')), 0) AS tokensIn,
       COALESCE(SUM(json_extract(payload, '$.tokens_out')), 0) AS tokensOut,
       COUNT(*) AS llmResponses
     FROM events
     WHERE event_type = 'llm.response' AND timestamp >= ?`,
    [sevenDaysAgo],
  ) || { totalCost: 0, tokensIn: 0, tokensOut: 0, llmResponses: 0 };

  const toolErrors = dbQueryOne(
    `SELECT COUNT(*) AS count
     FROM tool_calls tc
     JOIN events e ON e.event_id = tc.event_id
     WHERE tc.status = 'error' AND e.timestamp >= ?`,
    [sevenDaysAgo],
  ) || { count: 0 };

  const toolCalls = dbQueryOne(
    `SELECT COUNT(*) AS count
     FROM tool_calls tc
     JOIN events e ON e.event_id = tc.event_id
     WHERE e.timestamp >= ?`,
    [sevenDaysAgo],
  ) || { count: 0 };

  const recentErrors = dbQueryAll(
    `SELECT e.timestamp, er.session_id, er.code, er.message
     FROM errors er
     JOIN events e ON e.event_id = er.event_id
     WHERE e.timestamp >= ?
     ORDER BY e.timestamp DESC
     LIMIT 25`,
    [lastDay],
  );

  const topTools = dbQueryAll(
    `SELECT tc.tool_name AS toolName, COUNT(*) AS calls
     FROM tool_calls tc
     JOIN events e ON e.event_id = tc.event_id
     WHERE e.timestamp >= ?
     GROUP BY tc.tool_name
     ORDER BY calls DESC
     LIMIT 10`,
    [sevenDaysAgo],
  );

  return {
    host: HOST,
    port: PORT,
    acaHome: ACA_HOME,
    dbPath: DB_PATH,
    dbAvailable: Boolean(db),
    sessionsDir: SESSIONS_DIR,
    sessionCount: sessions.length,
    recentSessions: sessions.slice(0, 10),
    last7Days: {
      sessionCount: last7DaysSessions,
      totalCostUsd: Number(aggregate.totalCost || 0),
      tokensIn: Number(aggregate.tokensIn || 0),
      tokensOut: Number(aggregate.tokensOut || 0),
      llmResponses: Number(aggregate.llmResponses || 0),
      toolCalls: Number(toolCalls.count || 0),
      toolErrors: Number(toolErrors.count || 0),
      toolErrorRate: Number(toolCalls.count || 0) > 0 ? Number(toolErrors.count || 0) / Number(toolCalls.count || 0) : 0,
      topTools,
      daily: {
        sessions: buildDailySeriesFromRecords(sessions, 'startedAt', 7),
        costUsd: buildDailyDbSeries(
          `SELECT substr(timestamp, 1, 10) AS day,
                  COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS value
           FROM events
           WHERE event_type = 'llm.response' AND timestamp >= ?
           GROUP BY day`,
          [sevenDaysAgo],
          7,
        ),
        tokens: buildDailyDbSeries(
          `SELECT substr(timestamp, 1, 10) AS day,
                  COALESCE(SUM(json_extract(payload, '$.tokens_in')), 0) +
                  COALESCE(SUM(json_extract(payload, '$.tokens_out')), 0) AS value
           FROM events
           WHERE event_type = 'llm.response' AND timestamp >= ?
           GROUP BY day`,
          [sevenDaysAgo],
          7,
        ),
        toolErrors: buildDailyDbSeries(
          `SELECT substr(e.timestamp, 1, 10) AS day,
                  COUNT(*) AS value
           FROM tool_calls tc
           JOIN events e ON e.event_id = tc.event_id
           WHERE tc.status = 'error' AND e.timestamp >= ?
           GROUP BY day`,
          [sevenDaysAgo],
          7,
        ),
        recentErrors: buildDailyDbSeries(
          `SELECT substr(e.timestamp, 1, 10) AS day,
                  COUNT(*) AS value
           FROM errors er
           JOIN events e ON e.event_id = er.event_id
           WHERE e.timestamp >= ?
           GROUP BY day`,
          [sevenDaysAgo],
          7,
        ),
      },
    },
    recentErrors,
  };
}

function listSessions(limit) {
  const fromDb = dbQueryAll(
    `SELECT session_id AS sessionId, workspace_id AS workspaceId, started_at AS startedAt,
            ended_at AS endedAt, status, pruned
     FROM sessions
     ORDER BY started_at DESC
     LIMIT ?`,
    [limit],
  );
  if (fromDb.length > 0) return fromDb.map((session) => enrichSession(session, readManifest(session.sessionId)));

  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSessionId(entry.name))
    .map((entry) => readManifest(entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.lastActivityTimestamp || '').localeCompare(String(a.lastActivityTimestamp || '')))
    .slice(0, limit)
    .map((manifest) => enrichSession({
      sessionId: manifest.sessionId,
      workspaceId: manifest.workspaceId,
      startedAt: manifest.lastActivityTimestamp,
      endedAt: null,
      status: manifest.status,
      pruned: 0,
    }, manifest));
}

function sessionDetail(sessionId) {
  const manifest = readManifest(sessionId);
  const dbSession = dbQueryOne(
    `SELECT session_id AS sessionId, workspace_id AS workspaceId, started_at AS startedAt,
            ended_at AS endedAt, status, pruned
     FROM sessions WHERE session_id = ?`,
    [sessionId],
  );

  const events = dbQueryAll(
    `SELECT event_id AS eventId, event_type AS eventType, timestamp, payload
     FROM events
     WHERE session_id = ?
     ORDER BY timestamp ASC`,
    [sessionId],
  ).map((event) => ({ ...event, payload: safeJson(event.payload) }));

  const tools = dbQueryAll(
    `SELECT event_id AS eventId, tool_name AS toolName, status, duration_ms AS durationMs
     FROM tool_calls
     WHERE session_id = ?
     ORDER BY rowid ASC`,
    [sessionId],
  );

  const errors = dbQueryAll(
    `SELECT event_id AS eventId, code, message
     FROM errors
     WHERE session_id = ?
     ORDER BY rowid ASC`,
    [sessionId],
  );

  const turns = summarizeTurns(events, tools);
  return {
    session: enrichSession(
      dbSession || {
        sessionId,
        workspaceId: manifest?.workspaceId || null,
        startedAt: manifest?.lastActivityTimestamp || null,
        endedAt: null,
        status: manifest?.status || 'unknown',
        pruned: 0,
      },
      manifest,
    ),
    manifest,
    turns,
    errors,
    eventCount: events.length,
    toolCount: tools.length,
    recentEvents: events.slice(-100).reverse(),
  };
}

function listConsults(limit, since) {
  return scanConsultGroups()
    .map((group) => summarizeConsultGroup(group, false))
    .filter((c) => !since || String(c.startedAt || c.updatedAt || '') >= since)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}

function consultDetail(suffix) {
  const group = scanConsultGroups().find((item) => item.suffix === suffix);
  if (!group) {
    return {
      suffix,
      status: 'missing',
      witnesses: Object.fromEntries(SEEDED_WITNESSES.map((name) => [name, { name, status: 'pending', artifacts: [] }])),
      triage: { status: 'pending', artifacts: [] },
      artifacts: [],
    };
  }
  return summarizeConsultGroup(group, true);
}

function scanConsultGroups() {
  if (!existsSync(CONSULT_TMP_DIR)) return [];
  const groups = new Map();
  for (const entry of readdirSync(CONSULT_TMP_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('aca-consult-')) continue;
    const parsed = parseConsultArtifactName(entry.name);
    if (!parsed) continue;
    const path = join(CONSULT_TMP_DIR, entry.name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const group = groups.get(parsed.suffix) || {
      suffix: parsed.suffix,
      files: [],
      startedAt: consultStartedAt(parsed.suffix),
      updatedAt: null,
    };
    const artifact = {
      ...parsed,
      name: entry.name,
      path,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
    group.files.push(artifact);
    if (!group.updatedAt || artifact.mtime > group.updatedAt) group.updatedAt = artifact.mtime;
    groups.set(parsed.suffix, group);
  }
  return [...groups.values()];
}

function parseConsultArtifactName(name) {
  let match = name.match(/^aca-consult-result-(.+)\.json$/);
  if (match) return { suffix: match[1], kind: 'result', role: 'result', extension: 'json' };

  match = name.match(/^aca-consult-structured-review-(.+)\.(md|json)$/);
  if (match) return { suffix: match[1], kind: `structured-review-${match[2]}`, role: 'structured_review', extension: match[2] };

  match = name.match(/^aca-consult-shared-context-(.+)\.md$/);
  if (match) return { suffix: match[1], kind: 'shared-context', role: 'shared_context', extension: 'md' };

  match = name.match(/^aca-consult-triage-raw-(.+)\.md$/);
  if (match) return { suffix: match[1], kind: 'triage-raw', role: 'triage', extension: 'md' };

  match = name.match(/^aca-consult-triage-(.+)\.md$/);
  if (match) return { suffix: match[1], kind: 'triage', role: 'triage', extension: 'md' };

  match = name.match(/^aca-consult-([^-]+)-pending-(.+)\.md$/);
  if (match) return { suffix: match[2], kind: 'pending', role: 'witness', witness: match[1], extension: 'md' };

  match = name.match(/^aca-consult-([^-]+)-(context-request|response|final-raw|round-\d+)-(.+)\.md$/);
  if (match) {
    return {
      suffix: match[3],
      kind: match[2],
      role: 'witness',
      witness: match[1],
      extension: 'md',
    };
  }
  return null;
}

function summarizeConsultGroup(group, includePreviews) {
  const resultArtifact = group.files.find((file) => file.kind === 'result');
  const result = resultArtifact ? safeJson(readLimitedText(resultArtifact.path, MAX_PREVIEW_BYTES)) : null;
  const resultWitnesses = result?.witnesses && typeof result.witnesses === 'object' ? result.witnesses : {};
  const artifactWitnessNames = group.files
    .map((file) => file.witness)
    .filter((name) => typeof name === 'string' && name.trim() !== '');
  const witnessNames = [...new Set([...SEEDED_WITNESSES, ...artifactWitnessNames, ...Object.keys(resultWitnesses)])];
  const witnesses = {};

  for (const witnessName of witnessNames) {
    const witnessFiles = group.files.filter((file) => file.witness === witnessName)
      .sort((a, b) => a.name.localeCompare(b.name));
    const resultWitness = resultWitnesses[witnessName];
    const responseFile = witnessFiles.find((file) => file.kind === 'response');
    const finalRawFile = witnessFiles.find((file) => file.kind === 'final-raw');
    const requestFile = witnessFiles.find((file) => file.kind === 'context-request');
    const pendingFile = witnessFiles.find((file) => file.kind === 'pending');
    const status = resultWitness?.status
      || (responseFile ? 'ok' : finalRawFile || requestFile ? 'running' : pendingFile ? 'waiting' : 'pending');
    const selectedPreviewPath = resultWitness?.response_path || resultWitness?.triage_input_path || responseFile?.path || finalRawFile?.path || requestFile?.path;
    witnesses[witnessName] = {
      name: witnessName,
      model: resultWitness?.model || null,
      status,
      error: resultWitness?.error || null,
      usage: resultWitness?.usage || null,
      contextRequests: resultWitness?.context_requests || [],
      artifacts: witnessFiles.map((file) => artifactSummary(file, includePreviews)),
      preview: includePreviews && selectedPreviewPath ? readPreview(selectedPreviewPath) : null,
    };
  }

  const triageArtifacts = group.files
    .filter((file) => file.role === 'triage')
    .sort((a, b) => a.name.localeCompare(b.name));
  const structuredArtifacts = group.files
    .filter((file) => file.role === 'structured_review')
    .sort((a, b) => a.name.localeCompare(b.name));
  const sharedContextArtifacts = group.files
    .filter((file) => file.role === 'shared_context')
    .sort((a, b) => a.name.localeCompare(b.name));

  const triagePath = result?.triage?.path || result?.triage?.raw_path || triageArtifacts.find((file) => file.kind === 'triage')?.path || triageArtifacts[0]?.path;
  const status = result
    ? result.triage?.status === 'ok' || result.success_count === result.total_witnesses
      ? 'complete'
      : result.degraded ? 'degraded' : 'complete'
    : group.files.length > 0 ? 'running' : 'pending';

  return {
    suffix: group.suffix,
    startedAt: group.startedAt,
    updatedAt: group.updatedAt,
    status,
    resultPath: resultArtifact?.path || result?.result_path || null,
    successCount: result?.success_count ?? Object.values(witnesses).filter((witness) => witness.status === 'ok').length,
    totalWitnesses: result?.total_witnesses ?? witnessNames.length,
    degraded: Boolean(result?.degraded),
    witnesses,
    sharedContext: {
      status: result?.shared_context?.status || (sharedContextArtifacts.length ? 'ok' : 'skipped'),
      artifacts: sharedContextArtifacts.map((file) => artifactSummary(file, includePreviews)),
    },
    structuredReview: result?.structured_review || null,
    structuredArtifacts: structuredArtifacts.map((file) => artifactSummary(file, includePreviews)),
    triage: {
      status: result?.triage?.status || (triageArtifacts.length ? 'running' : 'pending'),
      model: result?.triage?.model || null,
      error: result?.triage?.error || null,
      usage: result?.triage?.usage || null,
      artifacts: triageArtifacts.map((file) => artifactSummary(file, includePreviews)),
      preview: includePreviews && triagePath ? readPreview(triagePath) : null,
    },
    artifacts: group.files
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
      .map((file) => artifactSummary(file, includePreviews)),
    result: includePreviews ? result : null,
  };
}

function artifactSummary(file, includePreview) {
  return {
    name: file.name,
    kind: file.kind,
    role: file.role,
    witness: file.witness || null,
    path: file.path,
    size: file.size,
    mtime: file.mtime,
    preview: includePreview ? readPreview(file.path) : null,
  };
}

function readPreview(path) {
  if (!path || !existsSync(path)) return null;
  return readLimitedText(path, MAX_PREVIEW_BYTES);
}

function readLimitedText(path, maxBytes) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return '';
    const text = readFileSync(path, 'utf-8');
    if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
    return text.slice(0, maxBytes) + `\n\n[debug UI truncated preview at ${maxBytes} bytes]`;
  } catch {
    return '';
  }
}

function consultStartedAt(suffix) {
  const millis = Number.parseInt(String(suffix).split('-')[0], 10);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString();
}

function summarizeTurns(events, tools) {
  const toolByEvent = new Map(tools.map((tool) => [tool.eventId, tool]));
  const turns = [];
  let current = null;

  for (const event of events) {
    if (event.eventType === 'turn.started') {
      current = {
        turn: event.payload?.turn_id || `turn-${turns.length + 1}`,
        startedAt: event.timestamp,
        endedAt: null,
        outcome: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        tools: [],
        errors: [],
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (event.eventType === 'llm.response') {
      current.tokensIn += numberOrZero(event.payload?.tokens_in);
      current.tokensOut += numberOrZero(event.payload?.tokens_out);
      current.costUsd += numberOrZero(event.payload?.cost_usd);
    } else if (event.eventType === 'tool.completed') {
      const tool = toolByEvent.get(event.eventId);
      current.tools.push({
        name: event.payload?.tool_name || tool?.toolName || '(unknown)',
        status: event.payload?.status || tool?.status || null,
        durationMs: event.payload?.duration_ms || tool?.durationMs || null,
      });
    } else if (event.eventType === 'error') {
      current.errors.push({
        code: event.payload?.code,
        message: event.payload?.message,
      });
    } else if (event.eventType === 'turn.ended') {
      current.endedAt = event.timestamp;
      current.outcome = event.payload?.outcome || null;
      current.stepCount = event.payload?.step_count || null;
      current.durationMs = event.payload?.duration_ms || null;
      current = null;
    }
  }
  return turns.reverse();
}

function readSessionJsonl(sessionId, fileName, limit) {
  const sessionDir = resolve(SESSIONS_DIR, sessionId);
  const filePath = resolve(sessionDir, fileName);
  if (!filePath.startsWith(resolve(SESSIONS_DIR) + '/') || !existsSync(filePath)) return [];
  const stat = statSync(filePath);
  if (stat.size > MAX_JSONL_BYTES) {
    return [{ recordType: 'debug_ui_notice', message: `${fileName} is ${stat.size} bytes; refusing to load more than ${MAX_JSONL_BYTES} bytes.` }];
  }
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => safeJson(line)).reverse();
}

function readManifest(sessionId) {
  const manifestPath = join(SESSIONS_DIR, sessionId, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  return safeJson(readFileSync(manifestPath, 'utf-8'));
}

function diskSessionInfo(sessionId) {
  const dir = join(SESSIONS_DIR, sessionId);
  const manifest = join(dir, 'manifest.json');
  const conversation = join(dir, 'conversation.jsonl');
  const events = join(dir, 'events.jsonl');
  return {
    dir,
    exists: existsSync(dir),
    manifest: existsSync(manifest),
    conversation: existsSync(conversation),
    events: existsSync(events),
  };
}

function enrichSession(session, manifest = readManifest(session.sessionId)) {
  const metrics = sessionAggregate(session.sessionId);
  const errorCount = Number(metrics?.errorCount || 0);
  return {
    ...session,
    startedAt: session.startedAt || manifest?.lastActivityTimestamp || null,
    endedAt: session.endedAt || null,
    lastActivityAt: metrics?.lastActivityAt || manifest?.lastActivityTimestamp || session.endedAt || session.startedAt || null,
    turnCount: Number(metrics?.turnCount || manifest?.turnCount || 0),
    totalCostUsd: numberOrZero(metrics?.totalCostUsd),
    tokensIn: numberOrZero(metrics?.tokensIn),
    tokensOut: numberOrZero(metrics?.tokensOut),
    errorCount,
    hasErrors: errorCount > 0,
    workspaceRoot: manifest?.configSnapshot?.workspaceRoot || null,
    model: manifest?.configSnapshot?.model || null,
    ephemeral: manifest?.ephemeral === true,
    disk: diskSessionInfo(session.sessionId),
  };
}

function sessionAggregate(sessionId) {
  return dbQueryOne(
    `SELECT
       MAX(timestamp) AS lastActivityAt,
       COALESCE(SUM(CASE WHEN event_type = 'turn.started' THEN 1 ELSE 0 END), 0) AS turnCount,
       COALESCE(SUM(CASE WHEN event_type = 'llm.response' THEN json_extract(payload, '$.tokens_in') ELSE 0 END), 0) AS tokensIn,
       COALESCE(SUM(CASE WHEN event_type = 'llm.response' THEN json_extract(payload, '$.tokens_out') ELSE 0 END), 0) AS tokensOut,
       COALESCE(SUM(CASE WHEN event_type = 'llm.response' THEN json_extract(payload, '$.cost_usd') ELSE 0 END), 0) AS totalCostUsd,
       COALESCE(SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END), 0) AS errorCount
     FROM events
     WHERE session_id = ?`,
    [sessionId],
  );
}

function buildDailySeriesFromRecords(records, fieldName, days) {
  const buckets = buildDailyBuckets(days);
  for (const record of records) {
    const day = String(record?.[fieldName] || '').slice(0, 10);
    if (!buckets.has(day)) continue;
    buckets.set(day, buckets.get(day) + 1);
  }
  return [...buckets.entries()].map(([day, value]) => ({ day, value }));
}

function buildDailyDbSeries(sql, params, days) {
  const buckets = buildDailyBuckets(days);
  for (const row of dbQueryAll(sql, params)) {
    const day = String(row?.day || '').slice(0, 10);
    if (!buckets.has(day)) continue;
    buckets.set(day, numberOrZero(row.value));
  }
  return [...buckets.entries()].map(([day, value]) => ({ day, value }));
}

function buildDailyBuckets(days) {
  const buckets = new Map();
  const anchor = new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(anchor.getTime() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    buckets.set(day, 0);
  }
  return buckets;
}

function dbQueryAll(sql, params = []) {
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

function dbQueryOne(sql, params = []) {
  if (!db) return null;
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: true, raw: String(text).slice(0, 2000) };
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function isSessionId(value) {
  return /^ses_[0-9A-HJKMNP-TV-Z]{26}$/i.test(value);
}

function isConsultSuffix(value) {
  return /^[0-9]{10,}-[0-9]+$/.test(value);
}

function isAuthorized(req, url) {
  const headerToken = req.headers['x-aca-debug-token'];
  return url.searchParams.get('token') === TOKEN || headerToken === TOKEN;
}

function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return true;
  const host = hostHeader.split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

function loginHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ACA Debug UI</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0e1012;
      color: #e7ebf0;
      font: 14px/1.5 Inter, system-ui, sans-serif;
    }
    main {
      width: min(100%, 480px);
      padding: 24px;
      border: 1px solid #23282e;
      border-radius: 12px;
      background: #14171a;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 20px;
    }
    p {
      margin: 0;
      color: #aab3bd;
    }
  </style>
</head>
<body>
  <main>
    <h1>ACA Debug UI</h1>
    <p>This local dashboard requires the token printed by the server.</p>
  </main>
</body>
</html>`;
}

function appHtml() {
  try {
    return readFileSync(APP_HTML_URL, 'utf-8');
  } catch (error) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ACA Debug UI</title>
</head>
<body>
  <main style="max-width:680px;margin:80px auto;font:14px/1.5 system-ui,sans-serif">
    <h1>ACA Debug UI</h1>
    <p>Failed to load aca-debug-ui-app.html.</p>
    <pre>${String(error instanceof Error ? error.message : error)}</pre>
  </main>
</body>
</html>`;
  }
}
