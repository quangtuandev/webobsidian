import { getSettings } from '../settings.js';
import { LocalStorageProvider } from './local.js';
import { R2StorageProvider } from './r2.js';
import type { IStorageProvider } from './types.js';

let localProviderInstance: LocalStorageProvider | null = null;
let r2ProviderInstance: R2StorageProvider | null = null;

export async function getStorageProvider(): Promise<IStorageProvider> {
  const settings = await getSettings();
  const providerType = settings.storage?.provider || 'local';

  if (providerType === 'r2') {
    if (!r2ProviderInstance) {
      r2ProviderInstance = new R2StorageProvider();
    }
    return r2ProviderInstance;
  }

  if (!localProviderInstance) {
    localProviderInstance = new LocalStorageProvider();
  }
  return localProviderInstance;
}

export * from './types.js';
export { LocalStorageProvider } from './local.js';
export { R2StorageProvider } from './r2.js';
