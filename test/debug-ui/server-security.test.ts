import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDebugUiUrl,
  hasValidDebugToken,
  isAuthorized,
  isLocalHostHeader,
  isLoopbackRemoteAddress,
  normalizeDebugUiHost,
} from '../../scripts/aca-debug-ui-security.mjs';

const children = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
});

describe('debug UI server security', () => {
  it('normalizes bind hosts to loopback only', () => {
    expect(normalizeDebugUiHost('0.0.0.0')).toBe('127.0.0.1');
    expect(normalizeDebugUiHost('192.168.1.20')).toBe('127.0.0.1');
    expect(normalizeDebugUiHost('127.0.0.2')).toBe('127.0.0.2');
    expect(normalizeDebugUiHost('[::1]')).toBe('::1');
  });

  it('recognizes only loopback host headers and remote addresses as local', () => {
    expect(isLocalHostHeader('127.0.0.1:4777')).toBe(true);
    expect(isLocalHostHeader('localhost:4777')).toBe(true);
    expect(isLocalHostHeader('[::1]:4777')).toBe(true);
    expect(isLocalHostHeader('192.168.1.20:4777')).toBe(false);

    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('::1')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('192.168.1.50')).toBe(false);
  });

  it('allows tokenless loopback requests but not remote requests', () => {
    const url = new URL('http://127.0.0.1:4777/api/overview');
    const localReq = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const remoteReq = { headers: {}, socket: { remoteAddress: '192.168.1.50' } };
    const tokenReq = { headers: { 'x-aca-debug-token': 'secret' }, socket: { remoteAddress: '192.168.1.50' } };

    expect(isAuthorized(localReq, url, { token: 'secret', requireToken: false })).toBe(true);
    expect(isAuthorized(remoteReq, url, { token: 'secret', requireToken: false })).toBe(false);
    expect(isAuthorized(localReq, url, { token: 'secret', requireToken: true })).toBe(false);
    expect(hasValidDebugToken(tokenReq, url, 'secret')).toBe(true);
  });

  it('builds tokenless dashboard URLs unless explicit token mode is enabled', () => {
    expect(buildDebugUiUrl('127.0.0.1', 4777, 'secret', false)).toBe('http://127.0.0.1:4777/');
    expect(buildDebugUiUrl('::1', 4777, 'secret', false)).toBe('http://[::1]:4777/');
    expect(buildDebugUiUrl('127.0.0.1', 4777, 'secret', true)).toBe('http://127.0.0.1:4777/?token=secret');
  });

  it('serves the dashboard and read APIs without a token on loopback while protecting shutdown', async () => {
    const acaHome = mkdtempSync(join(tmpdir(), 'aca-debug-ui-security-'));
    mkdirSync(acaHome, { recursive: true });
    const metadataPath = join(acaHome, 'debug-ui.json');
    const child = spawn(process.execPath, ['scripts/aca-debug-ui-server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACA_HOME: acaHome,
        ACA_DEBUG_UI_HOST: '0.0.0.0',
        ACA_DEBUG_UI_PORT: '0',
        ACA_DEBUG_UI_METADATA_PATH: metadataPath,
      },
      stdio: 'ignore',
    });
    children.push(child);

    const metadata = await waitForMetadata(metadataPath);
    expect(metadata.host).toBe('127.0.0.1');
    expect(metadata.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const root = await fetch(metadata.url);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('ACA Debug UI');

    const overview = await fetch(`http://${metadata.host}:${metadata.port}/api/overview`);
    expect(overview.status).toBe(200);

    const shutdownWithoutToken = await post(`http://${metadata.host}:${metadata.port}/api/control/shutdown`);
    expect(shutdownWithoutToken.status).toBe(401);

    const shutdownWithToken = await post(`http://${metadata.host}:${metadata.port}/api/control/shutdown?token=${encodeURIComponent(metadata.token)}`);
    expect(shutdownWithToken.status).toBe(200);

    await stopChild(child);
    rmSync(acaHome, { recursive: true, force: true });
  });
});

async function waitForMetadata(path) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      await delay(50);
    }
  }
  throw new Error(`metadata not written: ${path}`);
}

function post(url) {
  return new Promise((resolvePost, rejectPost) => {
    const req = request(url, { method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolvePost({ status: res.statusCode }));
    });
    req.on('error', rejectPost);
    req.end();
  });
}

function stopChild(child) {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    child.once('exit', () => resolveStop());
    child.kill();
    setTimeout(() => resolveStop(), 1000).unref();
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
