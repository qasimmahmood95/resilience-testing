// Minimal typed client for the Toxiproxy HTTP API (v2).
// https://github.com/Shopify/toxiproxy#http-api - kept dependency-free so the
// suite controls exactly what goes over the wire.

import { BUDGET_FAST_MS, TOXIPROXY_URL, type ProxyName } from './config.js';

export type ToxicType = 'latency' | 'timeout' | 'bandwidth' | 'reset_peer' | 'slicer' | 'limit_data' | 'slow_close';
export type ToxicStream = 'upstream' | 'downstream';

export interface Toxic {
  name: string;
  type: ToxicType;
  stream: ToxicStream;
  toxicity: number;
  attributes: Record<string, number>;
}

export interface ProxyInfo {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: Toxic[];
}

async function api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TOXIPROXY_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(BUDGET_FAST_MS),
  });
  if (!res.ok) {
    throw new Error(`toxiproxy ${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  // DELETE returns 204 with an empty body.
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function listProxies(): Promise<Record<string, ProxyInfo>> {
  return api('GET', '/proxies');
}

export async function listToxics(proxy: ProxyName): Promise<Toxic[]> {
  return api('GET', `/proxies/${proxy}/toxics`);
}

export interface AddToxicInput {
  proxy: ProxyName;
  type: ToxicType;
  stream: ToxicStream;
  /** Unique per proxy; defaults to `${type}_${stream}`. */
  name?: string;
  /** Probability 0..1 that the toxic applies to a connection; default 1. */
  toxicity?: number;
  attributes: Record<string, number>;
}

export async function addToxic(input: AddToxicInput): Promise<Toxic> {
  return api('POST', `/proxies/${input.proxy}/toxics`, {
    name: input.name ?? `${input.type}_${input.stream}`,
    type: input.type,
    stream: input.stream,
    toxicity: input.toxicity ?? 1,
    attributes: input.attributes,
  });
}

export async function removeToxic(proxy: ProxyName, name: string): Promise<void> {
  await api('DELETE', `/proxies/${proxy}/toxics/${name}`);
}

/** List every toxic on every proxy, without touching anything. */
export async function listAllToxics(): Promise<{ proxy: string; toxic: string }[]> {
  const proxies = await listProxies();
  return Object.values(proxies).flatMap((proxy) =>
    proxy.toxics.map((toxic) => ({ proxy: proxy.name, toxic: toxic.name })),
  );
}

/** Remove every toxic on every proxy; returns what was removed (for leak reporting). */
export async function removeAllToxics(): Promise<{ proxy: string; toxic: string }[]> {
  const removed: { proxy: string; toxic: string }[] = [];
  const proxies = await listProxies();
  for (const proxy of Object.values(proxies)) {
    for (const toxic of proxy.toxics) {
      await api('DELETE', `/proxies/${proxy.name}/toxics/${toxic.name}`);
      removed.push({ proxy: proxy.name, toxic: toxic.name });
    }
  }
  return removed;
}
