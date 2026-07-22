import type { Readable } from 'node:stream';

export interface StorageFileStat {
  size: number;
  mtime: number;
  ctime?: number;
}

export interface StorageTreeNode {
  name: string;
  path: string; // vault-relative, posix style
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number;
  ctime?: number;
  children?: StorageTreeNode[];
}

export interface TrashItem {
  name: string;
  path: string;
  original: string;
  ext: string;
  size: number;
  mtime: number;
}

export interface IStorageProvider {
  getProviderType(): 'local' | 'r2';
  listTree(): Promise<StorageTreeNode>;
  listMarkdownFiles(): Promise<string[]>;
  readFileText(relPath: string): Promise<string>;
  readFileBuffer(relPath: string): Promise<Buffer>;
  writeFileText(relPath: string, content: string): Promise<void>;
  writeFileBuffer(relPath: string, buf: Buffer): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  stat(relPath: string): Promise<StorageFileStat | null>;
  createFolder(relPath: string): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  copy(fromRel: string, toRel: string): Promise<string[]>;
  remove(relPath: string): Promise<void>;
  trash(relPath: string): Promise<string>;
  listTrash(): Promise<TrashItem[]>;
  restoreFromTrash(trashRel: string): Promise<string>;
  deleteFromTrash(trashRel: string): Promise<void>;
  emptyTrash(): Promise<void>;
  getReadStream(relPath: string, start?: number, end?: number): Promise<{ stream: Readable; size: number }>;
}
