import * as SecureStore from 'expo-secure-store';

const BACKEND_URL_KEY = 's3backup.backendUrl';
const TOKEN_KEY = 's3backup.bootstrapToken';
const LAST_FOLDER_KEY = 's3backup.lastFolder';

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
    SecureStore.deleteItemAsync(LAST_FOLDER_KEY),
  ]);
}

// Last destination folder the user picked for an upload. Used to
// pre-fill the FolderPicker on the next upload so a daily-use flow
// doesn't make you re-navigate the same path every time.
export async function getLastFolder(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_FOLDER_KEY);
}

export async function setLastFolder(prefix: string): Promise<void> {
  await SecureStore.setItemAsync(LAST_FOLDER_KEY, prefix);
}

// S3 Standard storage pricing used for in-app cost estimates.
// Ref: https://aws.amazon.com/s3/pricing/ (us-east-1, first 50 TB/month)
export const S3_STANDARD_USD_PER_GB = 0.023;
