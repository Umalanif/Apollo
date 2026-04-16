import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getEnv } from './env/schema';
import { logger } from './logger';

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ProxyAgents {
  http: HttpProxyAgent<string>;
  https: HttpsProxyAgent<string>;
}

export interface PlaywrightProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

function readProxyConfig(): ProxyConfig {
  const { PROXY_HOST, PROXY_PASSWORD, PROXY_PORT, PROXY_USERNAME } = getEnv();

  return {
    host: PROXY_HOST,
    port: PROXY_PORT,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
  };
}

export function getProxyConfig(): ProxyConfig {
  return readProxyConfig();
}

export function buildProxyServer(): string {
  const { host, port } = readProxyConfig();
  return `http://${host}:${port}`;
}

export function buildProxyUrl(): string {
  const { host, password, port, username } = readProxyConfig();
  return `http://${username}:${password}@${host}:${port}`;
}

export function getMaskedProxyUrl(): string {
  const { host, port, username } = readProxyConfig();
  return `http://${username}:***@${host}:${port}`;
}

export function getProxyFingerprint(): string {
  const { host, port, username } = readProxyConfig();
  return `${username}@${host}:${port}`;
}

export function getPlaywrightProxy(): PlaywrightProxyConfig {
  const { password, username } = readProxyConfig();

  return {
    server: buildProxyServer(),
    username,
    password,
  };
}

export function createProxyAgents(): ProxyAgents {
  const proxyUrl = buildProxyUrl();

  return {
    http: new HttpProxyAgent(proxyUrl),
    https: new HttpsProxyAgent(proxyUrl),
  };
}

export async function fetchJsonViaProxy<T>(url: string): Promise<T> {
  const { got } = await import('got');

  logger.debug({ url, proxy: getMaskedProxyUrl() }, 'Fetching JSON via proxy');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (got as any)(url, {
    agent: createProxyAgents(),
    responseType: 'json',
    timeout: {
      request: 30_000,
    },
    retry: {
      limit: 1,
    },
  });

  return response.body as T;
}
