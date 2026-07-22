import path from 'node:path';

/** Runtime configuration derived from environment variables. */
export interface RuntimeConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Default vault path used on first run if settings has none. */
  defaultVaultPath: string;
  /** Roots the folder browser is allowed to traverse. */
  allowedRoots: string[];
  initialPassword?: string;
  isProd: boolean;
  /**
   * Express `trust proxy` setting. Controls whether `X-Forwarded-*` headers are
   * honoured (and thus whether `req.ip`/`req.secure` derive from them). Defaults
   * to `true` (trust the immediate hop) so the common reverse-proxy deployment
   * keeps `X-Forwarded-Proto`-based `Secure` cookies working out of the box.
   * This is NOT a rate-limit risk: the login limiter keys on the real TCP socket
   * address, not `req.ip`, so F-03 (XFF spoofing) is closed regardless of this
   * value. Set `TRUST_PROXY=false` for a directly-exposed instance with no proxy.
   */
  trustProxy: boolean | number | string;
  /** Storage driver type: 'local' (default) or 'r2'. */
  storageProvider: 'local' | 'r2';
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    publicUrl: string;
    endpoint: string;
  };
}

function resolveRoots(): string[] {
  const raw = process.env.ALLOWED_ROOTS?.trim();
  if (raw) {
    return raw.split(',').map((p) => path.resolve(p.trim())).filter(Boolean);
  }
  return [];
}

/**
 * Parse the `TRUST_PROXY` env into an Express `trust proxy` value. Default is
 * `true` (trust the immediate hop) so the common reverse-proxy deployment keeps
 * `X-Forwarded-Proto`-based `Secure` cookies working without extra config; the
 * login rate limit is keyed on the TCP socket address so this is not an F-03
 * (XFF spoofing) risk. Accepts:
 *   - unset / 'true' / 'on'              → true (trust the immediate peer)
 *   - 'false' / 'off' / '0'             → false (no proxy → ignore X-Forwarded-*)
 *   - a non-negative integer             → number of trusted proxy hops
 *   - anything else                      → passed through as a subnet/preset
 *                                          list (e.g. 'loopback, 10.0.0.0/8').
 */
function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === 'off' || lower === '0') return false;
  if (lower === 'true' || lower === 'on') return true;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  return raw;
}

const r2AccountId = process.env.R2_ACCOUNT_ID?.trim() || '';
const r2Endpoint = process.env.R2_ENDPOINT?.trim() || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : '');

export const config: RuntimeConfig = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  defaultVaultPath: path.resolve(process.env.VAULT_PATH ?? './sample-vault'),
  allowedRoots: resolveRoots(),
  initialPassword: process.env.WEBOBSIDIAN_PASSWORD || undefined,
  isProd: process.env.NODE_ENV === 'production',
  trustProxy: resolveTrustProxy(),
  storageProvider: (process.env.STORAGE_PROVIDER?.trim().toLowerCase() === 'r2' ? 'r2' : 'local'),
  r2: {
    accountId: r2AccountId,
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || '',
    bucketName: process.env.R2_BUCKET_NAME?.trim() || '',
    publicUrl: process.env.R2_PUBLIC_URL?.trim() || '',
    endpoint: r2Endpoint,
  },
};

export const SETTINGS_FILE = path.join(config.dataDir, 'settings.json');
export const INDEX_FILE = path.join(config.dataDir, 'qmd-index.json');
