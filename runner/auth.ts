import {request, APIRequestContext, BrowserContext, Browser} from '@playwright/test';
import {writeFileSync, mkdirSync, existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const AUTH_DIR = resolve(ROOT, 'output', 'auth');

export interface PersonaLogin {
  email: string;
  password: string;
}

export interface Persona {
  label: string;
  login: PersonaLogin | null;
}

export type Personas = Record<string, Persona>;

export function loadPersonas(): Personas {
  const path = resolve(ROOT, 'config', 'personas.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function loginViaForm(api: APIRequestContext, baseUrl: string, login: PersonaLogin): Promise<void> {
  const loginUrl = `${baseUrl}/login/`;
  const get = await api.get(loginUrl);
  if (!get.ok()) {
    throw new Error(`GET ${loginUrl} -> ${get.status()}`);
  }
  const html = await get.text();
  // The form CSRF input — distinct from the page-wide csrf-token meta.
  const csrfMatch = html.match(/<input[^>]*name=["']csrf_token["'][^>]*value=["']([^"']+)["']/);
  if (!csrfMatch) {
    throw new Error(`Could not extract csrf_token from ${loginUrl}`);
  }
  const csrfToken = csrfMatch[1];

  const post = await api.post(loginUrl, {
    form: {
      csrf_token: csrfToken,
      _provider: 'indico',
      identifier: login.email,
      password: login.password,
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (post.status() !== 302 && post.status() !== 200 && post.status() !== 303) {
    throw new Error(`POST ${loginUrl} for ${login.email} -> ${post.status()}: ${await post.text()}`);
  }
}

export async function buildStorageStates(baseUrl: string, personas: Personas): Promise<Record<string, string | null>> {
  mkdirSync(AUTH_DIR, {recursive: true});
  const result: Record<string, string | null> = {};
  for (const [name, persona] of Object.entries(personas)) {
    if (persona.login === null) {
      result[name] = null;
      continue;
    }
    const api = await request.newContext({baseURL: baseUrl});
    await loginViaForm(api, baseUrl, persona.login);
    const state = await api.storageState();
    const path = resolve(AUTH_DIR, `${name}.json`);
    writeFileSync(path, JSON.stringify(state));
    await api.dispose();
    result[name] = path;
  }
  return result;
}

export async function newPersonaContext(
  browser: Browser,
  baseUrl: string,
  storagePath: string | null
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: baseUrl,
    storageState: storagePath && existsSync(storagePath) ? storagePath : undefined,
    viewport: {width: 1280, height: 900},
    timezoneId: 'UTC',
    locale: 'en-GB',
  });
}
