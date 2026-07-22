import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { getSettings } from '../settings.js';
import type { IStorageProvider, StorageFileStat, StorageTreeNode, TrashItem } from './types.js';

const IGNORED = new Set(['.git', 'node_modules']);
const statCache = new Map<string, { m: number; c: number }>();

export function invalidateStat(rel: string): void {
  statCache.delete(rel);
}

async function fileStat(abs: string, rel: string): Promise<{ m: number; c: number }> {
  const hit = statCache.get(rel);
  if (hit) return hit;
  let v = { m: 0, c: 0 };
  try {
    const st = await fs.stat(abs);
    v = { m: st.mtimeMs, c: st.birthtimeMs || st.mtimeMs };
  } catch { /* file vanished mid-walk */ }
  statCache.set(rel, v);
  return v;
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export class LocalStorageProvider implements IStorageProvider {
  getProviderType(): 'local' | 'r2' {
    return 'local';
  }

  private async getVaultRoot(): Promise<string> {
    const s = await getSettings();
    return path.resolve(s.vault.path);
  }

  private async resolveInVault(relPath: string): Promise<string> {
    const root = await this.getVaultRoot();
    const clean = relPath.replace(/^[/\\]+/, '');
    const abs = path.resolve(root, clean);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw Object.assign(new Error('Path escapes vault'), { status: 400 });
    }
    if (path.relative(root, abs).split(path.sep).includes('.git')) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
    await this.assertRealpathInVault(abs, root);
    return abs;
  }

  private async assertRealpathInVault(abs: string, root: string): Promise<void> {
    const realRoot = await fs.realpath(root).catch(() => root);
    const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRootSep)) {
          throw Object.assign(new Error('Path escapes vault'), { status: 400 });
        }
        return;
      } catch (e: any) {
        if (e?.status === 400) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }

  async listTree(): Promise<StorageTreeNode> {
    const root = await this.getVaultRoot();
    await fs.mkdir(root, { recursive: true });

    const walk = async (absDir: string): Promise<StorageTreeNode[]> => {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      const nodes = await Promise.all(
        entries
          .filter((e) => !(IGNORED.has(e.name) || e.name.startsWith('.')))
          .map(async (e): Promise<StorageTreeNode | null> => {
            const abs = path.join(absDir, e.name);
            const rel = toRel(root, abs);
            if (e.isDirectory()) {
              return { name: e.name, path: rel, type: 'folder', children: await walk(abs) };
            }
            if (e.isFile()) {
              const { m, c } = await fileStat(abs, rel);
              return { name: e.name, path: rel, type: 'file', ext: path.extname(e.name).toLowerCase(), mtime: m, ctime: c };
            }
            return null;
          }),
      );
      const out = nodes.filter((n): n is StorageTreeNode => n !== null);
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return out;
    };

    return { name: path.basename(root), path: '', type: 'folder', children: await walk(root) };
  }

  async listMarkdownFiles(): Promise<string[]> {
    const root = await this.getVaultRoot();
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(toRel(root, abs));
      }
    };
    await walk(root);
    return out;
  }

  async readFileText(relPath: string): Promise<string> {
    const abs = await this.resolveInVault(relPath);
    return fs.readFile(abs, 'utf8');
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    const abs = await this.resolveInVault(relPath);
    return fs.readFile(abs);
  }

  async writeFileText(relPath: string, content: string): Promise<void> {
    const abs = await this.resolveInVault(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${Date.now()}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
    invalidateStat(relPath);
  }

  async writeFileBuffer(relPath: string, buf: Buffer): Promise<void> {
    const abs = await this.resolveInVault(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    invalidateStat(relPath);
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      const abs = await this.resolveInVault(relPath);
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  async stat(relPath: string): Promise<StorageFileStat | null> {
    try {
      const abs = await this.resolveInVault(relPath);
      const st = await fs.stat(abs);
      return { size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.mtimeMs };
    } catch {
      return null;
    }
  }

  async createFolder(relPath: string): Promise<void> {
    const abs = await this.resolveInVault(relPath);
    await fs.mkdir(abs, { recursive: true });
  }

  async rename(fromRel: string, destRel: string): Promise<void> {
    const absFrom = await this.resolveInVault(fromRel);
    const absTo = await this.resolveInVault(destRel);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
    invalidateStat(fromRel);
    invalidateStat(destRel);
  }

  async copy(fromRel: string, destRel: string): Promise<string[]> {
    const absFrom = await this.resolveInVault(fromRel);
    const absTo = await this.resolveInVault(destRel);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.cp(absFrom, absTo, { recursive: true, errorOnExist: true, force: false });
    const root = await this.getVaultRoot();
    const out: string[] = [];
    const st = await fs.stat(absTo);
    if (st.isDirectory()) {
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (IGNORED.has(e.name)) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) out.push(toRel(root, abs));
        }
      };
      await walk(absTo);
    } else {
      out.push(toRel(root, absTo));
    }
    return out;
  }

  async remove(relPath: string): Promise<void> {
    const abs = await this.resolveInVault(relPath);
    await fs.rm(abs, { recursive: true, force: true });
    invalidateStat(relPath);
  }

  async trash(relPath: string): Promise<string> {
    const s = await getSettings();
    const root = await this.getVaultRoot();
    const absFrom = await this.resolveInVault(relPath);
    const trashRoot = path.join(root, s.vault.trash);
    const dest = path.join(trashRoot, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let finalDest = dest;
    const existsCheck = async (p: string) => {
      try { await fs.access(p); return true; } catch { return false; }
    };
    if (await existsCheck(finalDest)) {
      const ext = path.extname(dest);
      finalDest = `${dest.slice(0, dest.length - ext.length)}.${Date.now()}${ext}`;
    }
    await fs.rename(absFrom, finalDest);
    invalidateStat(relPath);
    return toRel(root, finalDest);
  }

  async listTrash(): Promise<TrashItem[]> {
    const s = await getSettings();
    const root = await this.getVaultRoot();
    const trashRoot = path.join(root, s.vault.trash);
    const out: TrashItem[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
        } else if (e.isFile()) {
          const st = await fs.stat(abs).catch(() => null);
          out.push({
            name: e.name,
            path: toRel(root, abs),
            original: path.relative(trashRoot, abs).split(path.sep).join('/'),
            ext: path.extname(e.name).toLowerCase(),
            size: st?.size ?? 0,
            mtime: st ? st.mtimeMs : 0,
          });
        }
      }
    };
    await walk(trashRoot);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async restoreFromTrash(trashRel: string): Promise<string> {
    const s = await getSettings();
    const root = await this.getVaultRoot();
    const trashRoot = path.join(root, s.vault.trash);
    const absFrom = await this.resolveInVault(trashRel);
    const relInTrash = path.relative(trashRoot, absFrom);
    let destRel = relInTrash.split(path.sep).join('/');
    let absTo = await this.resolveInVault(destRel);
    const existsCheck = async (p: string) => {
      try { await fs.access(p); return true; } catch { return false; }
    };
    if (await existsCheck(absTo)) {
      const ext = path.extname(destRel);
      destRel = `${destRel.slice(0, destRel.length - ext.length)}.restored-${Date.now()}${ext}`;
      absTo = await this.resolveInVault(destRel);
    }
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
    return destRel;
  }

  async deleteFromTrash(trashRel: string): Promise<void> {
    const abs = await this.resolveInVault(trashRel);
    await fs.rm(abs, { recursive: true, force: true });
  }

  async emptyTrash(): Promise<void> {
    const s = await getSettings();
    const root = await this.getVaultRoot();
    const trashRoot = path.join(root, s.vault.trash);
    let entries;
    try {
      entries = await fs.readdir(trashRoot);
    } catch {
      return;
    }
    for (const name of entries) {
      await fs.rm(path.join(trashRoot, name), { recursive: true, force: true });
    }
  }

  async getReadStream(relPath: string, start?: number, end?: number): Promise<{ stream: Readable; size: number }> {
    const abs = await this.resolveInVault(relPath);
    const { size } = await fs.stat(abs);
    const opts: { start?: number; end?: number } = {};
    if (start !== undefined) opts.start = start;
    if (end !== undefined) opts.end = end;
    const stream = createReadStream(abs, opts);
    return { stream, size };
  }
}
