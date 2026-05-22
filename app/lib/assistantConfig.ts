import * as SecureStore from 'expo-secure-store';

export type SavedProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

const KEY_PROVIDERS = 's3backup.llm.providers';
const KEY_ACTIVE_ID = 's3backup.llm.activeId';
const KEY_PRIVACY = 's3backup.assistantPrivacyAcknowledged';
const KEY_CONTEXT_PREFIX = 's3backup.assistantContextPrefix';
const KEY_SESSION_RESET = 's3backup.assistantSessionResetVersion';
const KEY_SEEDED = 's3backup.llm.seeded';

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const DEFAULTS: ReadonlyArray<Omit<SavedProvider, 'id'>> = [
  {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: null,
    model: '',
  },
  {
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    apiKey: null,
    model: '',
  },
  {
    name: 'Ollama Local',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    model: '',
  },
];

async function readProviders(): Promise<SavedProvider[]> {
  const raw = await SecureStore.getItemAsync(KEY_PROVIDERS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedProvider =>
        p &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.baseUrl === 'string' &&
        typeof p.model === 'string',
    );
  } catch {
    return [];
  }
}

async function writeProviders(providers: SavedProvider[]): Promise<void> {
  await SecureStore.setItemAsync(KEY_PROVIDERS, JSON.stringify(providers));
}

async function seedIfNeeded(): Promise<SavedProvider[]> {
  const seeded = await SecureStore.getItemAsync(KEY_SEEDED);
  if (seeded === '1') return readProviders();

  const existing = await readProviders();
  if (existing.length > 0) {
    await SecureStore.setItemAsync(KEY_SEEDED, '1');
    return existing;
  }

  const seededProviders: SavedProvider[] = DEFAULTS.map((d) => ({ ...d, id: uid() }));
  await writeProviders(seededProviders);
  await SecureStore.setItemAsync(KEY_ACTIVE_ID, seededProviders[0]!.id);
  await SecureStore.setItemAsync(KEY_SEEDED, '1');
  return seededProviders;
}

export async function getProviders(): Promise<SavedProvider[]> {
  return seedIfNeeded();
}

export async function getActiveProviderId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_ACTIVE_ID);
}

export async function getActiveProvider(): Promise<SavedProvider | null> {
  const providers = await getProviders();
  if (providers.length === 0) return null;
  const activeId = await getActiveProviderId();
  const found = providers.find((p) => p.id === activeId);
  return found ?? providers[0]!;
}

export async function setActiveProvider(id: string): Promise<void> {
  const providers = await getProviders();
  if (!providers.find((p) => p.id === id)) return;
  const previous = await SecureStore.getItemAsync(KEY_ACTIVE_ID);
  await SecureStore.setItemAsync(KEY_ACTIVE_ID, id);
  if (previous !== id) {
    await bumpAssistantSessionResetVersion();
  }
}

export async function addProvider(
  partial: Omit<SavedProvider, 'id'>,
): Promise<SavedProvider> {
  const providers = await getProviders();
  const next: SavedProvider = { ...partial, id: uid() };
  await writeProviders([...providers, next]);
  return next;
}

export async function updateProvider(
  id: string,
  patch: Partial<Omit<SavedProvider, 'id'>>,
): Promise<void> {
  const providers = await getProviders();
  const next = providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
  await writeProviders(next);
}

export async function removeProvider(id: string): Promise<void> {
  const providers = await getProviders();
  const next = providers.filter((p) => p.id !== id);
  await writeProviders(next);
  const activeId = await SecureStore.getItemAsync(KEY_ACTIVE_ID);
  if (activeId === id) {
    const fallback = next[0]?.id ?? null;
    if (fallback) {
      await SecureStore.setItemAsync(KEY_ACTIVE_ID, fallback);
    } else {
      await SecureStore.deleteItemAsync(KEY_ACTIVE_ID);
    }
    await bumpAssistantSessionResetVersion();
  }
}

export function isProviderUsable(p: SavedProvider | null): p is SavedProvider {
  if (!p) return false;
  if (!p.baseUrl.trim() || !p.model.trim()) return false;
  // Ollama Local is the only preset that legitimately runs keyless.
  const isLocalLoopback = /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.)/i.test(
    p.baseUrl,
  );
  if (!isLocalLoopback && !p.apiKey?.trim()) return false;
  return true;
}

export async function isPrivacyAcknowledged(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(KEY_PRIVACY);
  return val === '1';
}

export async function acknowledgePrivacy(): Promise<void> {
  await SecureStore.setItemAsync(KEY_PRIVACY, '1');
}

export async function getAssistantContextPrefix(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_CONTEXT_PREFIX);
}

export async function setAssistantContextPrefix(prefix: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_CONTEXT_PREFIX, prefix);
}

export async function getAssistantSessionResetVersion(): Promise<number> {
  const raw = await SecureStore.getItemAsync(KEY_SESSION_RESET);
  const n = parseInt(raw ?? '0', 10);
  return Number.isNaN(n) ? 0 : n;
}

export async function bumpAssistantSessionResetVersion(): Promise<void> {
  const current = await getAssistantSessionResetVersion();
  await SecureStore.setItemAsync(KEY_SESSION_RESET, String(current + 1));
}
