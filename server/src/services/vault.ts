import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings.js';
import { getStorageProvider, type StorageTreeNode, type TrashItem } from './storage/index.js';

export type TreeNode = StorageTreeNode;
export type { TrashItem } from './storage/index.js';

export function invalidateStat(rel: string): void {
  // no-op or proxy to local cache if local
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.canvas', '.css', '.js', '.yml', '.yaml',
]);

export async function getVaultRoot(): Promise<string> {
  const s = await getSettings();
  return path.resolve(s.vault.path);
}

/** Resolve a vault-relative path to an absolute one on local disk (used for local guards/git). */
export async function resolveInVault(relPath: string): Promise<string> {
  const root = await getVaultRoot();
  const clean = relPath.replace(/^[/\\]+/, '');
  const abs = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw Object.assign(new Error('Path escapes vault'), { status: 400 });
  }
  if (path.relative(root, abs).split(path.sep).includes('.git')) {
    throw Object.assign(new Error('Path not allowed'), { status: 400 });
  }
  return abs;
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export async function ensureVault(): Promise<void> {
  const provider = await getStorageProvider();
  if (provider.getProviderType() === 'local') {
    const root = await getVaultRoot();
    await fs.mkdir(root, { recursive: true });
  }
}

/** Build the full tree (folders + files), skipping ignored dirs. */
export async function listTree(): Promise<TreeNode> {
  const provider = await getStorageProvider();
  return provider.listTree();
}

export function isTextFile(rel: string): boolean {
  return TEXT_EXTS.has(path.extname(rel).toLowerCase());
}

export async function readFileText(rel: string): Promise<string> {
  const provider = await getStorageProvider();
  return provider.readFileText(rel);
}

export async function readFileBuffer(rel: string): Promise<Buffer> {
  const provider = await getStorageProvider();
  return provider.readFileBuffer(rel);
}

export async function writeFileText(rel: string, content: string): Promise<void> {
  const provider = await getStorageProvider();
  return provider.writeFileText(rel, content);
}

export async function writeFileBuffer(rel: string, buf: Buffer): Promise<void> {
  const provider = await getStorageProvider();
  return provider.writeFileBuffer(rel, buf);
}

export async function createFolder(rel: string): Promise<void> {
  const provider = await getStorageProvider();
  return provider.createFolder(rel);
}

export async function resolveDirCaseInsensitive(rel: string): Promise<string> {
  const provider = await getStorageProvider();
  if (provider.getProviderType() === 'local') {
    const root = await getVaultRoot();
    const segs = rel.split('/').filter(Boolean);
    const out: string[] = [];
    let curAbs = root;
    for (const seg of segs) {
      let actual = seg;
      try {
        const entries = await fs.readdir(curAbs, { withFileTypes: true });
        const exact = entries.find((e) => e.isDirectory() && e.name === seg);
        const ci = exact ?? entries.find((e) => e.isDirectory() && e.name.toLowerCase() === seg.toLowerCase());
        if (ci) actual = ci.name;
      } catch {
        /* directory doesn't exist yet */
      }
      out.push(actual);
      curAbs = path.join(curAbs, actual);
    }
    return out.join('/');
  }
  return rel;
}

export async function exists(rel: string): Promise<boolean> {
  const provider = await getStorageProvider();
  return provider.exists(rel);
}

export async function rename(from: string, to: string): Promise<void> {
  const provider = await getStorageProvider();
  return provider.rename(from, to);
}

export async function copy(from: string, to: string): Promise<string[]> {
  const provider = await getStorageProvider();
  return provider.copy(from, to);
}

export async function remove(rel: string): Promise<void> {
  const provider = await getStorageProvider();
  return provider.remove(rel);
}

export async function trash(rel: string): Promise<string> {
  const provider = await getStorageProvider();
  return provider.trash(rel);
}

export async function listTrash(): Promise<TrashItem[]> {
  const provider = await getStorageProvider();
  return provider.listTrash();
}

export async function restoreFromTrash(trashRel: string): Promise<string> {
  const provider = await getStorageProvider();
  return provider.restoreFromTrash(trashRel);
}

export async function deleteFromTrash(trashRel: string): Promise<void> {
  const provider = await getStorageProvider();
  return provider.deleteFromTrash(trashRel);
}

export async function emptyTrash(): Promise<void> {
  const provider = await getStorageProvider();
  return provider.emptyTrash();
}

export async function listMarkdownFiles(): Promise<string[]> {
  const provider = await getStorageProvider();
  return provider.listMarkdownFiles();
}
