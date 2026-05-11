import { isIP } from 'node:net';

export const DEFAULT_DEBUG_UI_HOST = '127.0.0.1';

export function truthyEnvFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function normalizeDebugUiHost(rawHost) {
  const host = stripHostBrackets(String(rawHost || '').trim() || DEFAULT_DEBUG_UI_HOST);
  return isLoopbackHost(host) ? host : DEFAULT_DEBUG_UI_HOST;
}

export function formatHostForUrl(host) {
  const normalized = stripHostBrackets(String(host || '').trim() || DEFAULT_DEBUG_UI_HOST);
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

export function buildDebugUiUrl(host, port, token, requireToken) {
  const base = `http://${formatHostForUrl(host)}:${port}/`;
  return requireToken ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return true;
  const hostname = hostHeaderHostname(hostHeader);
  return hostname ? isLoopbackHost(hostname) : false;
}

export function hostHeaderHostname(hostHeader) {
  const value = String(hostHeader || '').trim();
  if (!value) return null;

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end <= 1) return null;
    return stripHostBrackets(value.slice(0, end + 1));
  }

  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount === 0) return value.toLowerCase();
  if (colonCount === 1) return value.slice(0, value.indexOf(':')).toLowerCase();
  return value.toLowerCase();
}

export function isLoopbackRequest(req) {
  return isLoopbackRemoteAddress(req?.socket?.remoteAddress);
}

export function isAuthorized(req, url, options) {
  if (hasValidDebugToken(req, url, options.token)) return true;
  if (options.requireToken) return false;
  return isLoopbackRequest(req);
}

export function hasValidDebugToken(req, url, token) {
  const headerToken = req?.headers?.['x-aca-debug-token'];
  return url.searchParams.get('token') === token || headerToken === token;
}

export function isLoopbackRemoteAddress(address) {
  const normalized = stripHostBrackets(String(address || '').trim().toLowerCase());
  if (!normalized) return false;
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length));
  }
  return isLoopbackHost(normalized);
}

export function isLoopbackHost(host) {
  const normalized = stripHostBrackets(String(host || '').trim().toLowerCase());
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.');
    return octets.length === 4 && octets[0] === '127' && octets.every(isIpv4Octet);
  }
  return false;
}

function stripHostBrackets(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isIpv4Octet(value) {
  if (!/^[0-9]+$/.test(value)) return false;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
}
