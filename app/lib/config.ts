import * as SecureStore from 'expo-secure-store';

const BACKEND_URL_KEY = 's3backup.backendUrl';
const TOKEN_KEY = 's3backup.bootstrapToken';

export type AppConfig = {
  backendUrl: string;
  bootstrapToken: string;
};

export async function loadConfig(): Promise<AppConfig | null> {
  const [backendUrl, bootstrapToken] = await Promise.all([
    SecureStore.getItemAsync(BACKEND_URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!backendUrl || !bootstrapToken) return null;
  return { backendUrl, bootstrapToken };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const url = config.backendUrl.trim().replace(/\/+$/, '');
  await Promise.all([
    SecureStore.setItemAsync(BACKEND_URL_KEY, url),
    SecureStore.setItemAsync(TOKEN_KEY, config.bootstrapToken.trim()),
  ]);
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(BACKEND_URL_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
}
