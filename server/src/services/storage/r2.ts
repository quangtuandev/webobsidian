import { Readable } from 'node:stream';
import path from 'node:path';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { getSettings } from '../settings.js';
import type { IStorageProvider, StorageFileStat, StorageTreeNode, TrashItem } from './types.js';

function cleanPath(relPath: string): string {
  return relPath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

export class R2StorageProvider implements IStorageProvider {
  private client: S3Client | null = null;
  private bucket: string = '';

  getProviderType(): 'local' | 'r2' {
    return 'r2';
  }

  private async getClient(): Promise<{ client: S3Client; bucket: string }> {
    const s = await getSettings();
    const st = s.storage;
    if (!st.r2BucketName || !st.r2AccessKeyId || !st.r2SecretAccessKey) {
      throw Object.assign(new Error('Cloudflare R2 is not fully configured in settings or environment'), { status: 400 });
    }

    if (!this.client || this.bucket !== st.r2BucketName) {
      const endpoint = st.r2Endpoint || `https://${st.r2AccountId}.r2.cloudflarestorage.com`;
      this.bucket = st.r2BucketName;
      this.client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: st.r2AccessKeyId,
          secretAccessKey: st.r2SecretAccessKey,
        },
      });
    }

    return { client: this.client, bucket: this.bucket };
  }

  async listTree(): Promise<StorageTreeNode> {
    const { client, bucket } = await this.getClient();
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;
    const items: Array<{ key: string; size: number; mtime: number }> = [];

    while (isTruncated) {
      const res: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        }),
      );
      if (res.Contents) {
        for (const obj of res.Contents) {
          if (!obj.Key) continue;
          const parts = obj.Key.split('/');
          if (parts.some((p: string) => p === '.git' || p === 'node_modules' || p.startsWith('.'))) continue;
          items.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            mtime: obj.LastModified ? obj.LastModified.getTime() : Date.now(),
          });
        }
      }
      isTruncated = !!res.IsTruncated;
      continuationToken = res.NextContinuationToken;
    }

    const rootNode: StorageTreeNode = { name: bucket, path: '', type: 'folder', children: [] };
    const folderMap = new Map<string, StorageTreeNode>();
    folderMap.set('', rootNode);

    const ensureFolder = (dirPath: string): StorageTreeNode => {
      if (folderMap.has(dirPath)) return folderMap.get(dirPath)!;
      const parentPath = path.posix.dirname(dirPath);
      const parentNode = ensureFolder(parentPath === '.' ? '' : parentPath);
      const folderName = path.posix.basename(dirPath);
      const folderNode: StorageTreeNode = {
        name: folderName,
        path: dirPath,
        type: 'folder',
        children: [],
      };
      parentNode.children = parentNode.children || [];
      parentNode.children.push(folderNode);
      folderMap.set(dirPath, folderNode);
      return folderNode;
    };

    for (const item of items) {
      const dirPath = path.posix.dirname(item.key);
      const parentNode = ensureFolder(dirPath === '.' ? '' : dirPath);
      const fileName = path.posix.basename(item.key);
      const ext = path.extname(fileName).toLowerCase();
      parentNode.children = parentNode.children || [];
      parentNode.children.push({
        name: fileName,
        path: item.key,
        type: 'file',
        ext,
        size: item.size,
        mtime: item.mtime,
      });
    }

    const sortTree = (node: StorageTreeNode) => {
      if (!node.children) return;
      node.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of node.children) {
        if (child.type === 'folder') sortTree(child);
      }
    };

    sortTree(rootNode);
    return rootNode;
  }

  async listMarkdownFiles(): Promise<string[]> {
    const { client, bucket } = await this.getClient();
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;
    const out: string[] = [];

    while (isTruncated) {
      const res: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        }),
      );
      if (res.Contents) {
        for (const obj of res.Contents) {
          if (!obj.Key) continue;
          const parts = obj.Key.split('/');
          if (parts.some((p: string) => p === '.git' || p === 'node_modules' || p.startsWith('.'))) continue;
          if (/\.(md|markdown)$/i.test(obj.Key)) {
            out.push(obj.Key);
          }
        }
      }
      isTruncated = !!res.IsTruncated;
      continuationToken = res.NextContinuationToken;
    }

    return out;
  }

  async readFileText(relPath: string): Promise<string> {
    const buf = await this.readFileBuffer(relPath);
    return buf.toString('utf8');
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    const { client, bucket } = await this.getClient();
    const key = cleanPath(relPath);
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) throw new Error(`Empty response body for ${key}`);
      const byteArray = await res.Body.transformToByteArray();
      return Buffer.from(byteArray);
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        throw Object.assign(new Error(`File not found: ${relPath}`), { status: 404 });
      }
      throw err;
    }
  }

  async writeFileText(relPath: string, content: string): Promise<void> {
    await this.writeFileBuffer(relPath, Buffer.from(content, 'utf8'));
  }

  async writeFileBuffer(relPath: string, buf: Buffer): Promise<void> {
    const { client, bucket } = await this.getClient();
    const key = cleanPath(relPath);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buf,
      }),
    );
  }

  async exists(relPath: string): Promise<boolean> {
    const st = await this.stat(relPath);
    return st !== null;
  }

  async stat(relPath: string): Promise<StorageFileStat | null> {
    const { client, bucket } = await this.getClient();
    const key = cleanPath(relPath);
    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: res.ContentLength ?? 0,
        mtime: res.LastModified ? res.LastModified.getTime() : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async createFolder(relPath: string): Promise<void> {
    const { client, bucket } = await this.getClient();
    const key = cleanPath(relPath).replace(/\/?$/, '/');
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.alloc(0) }));
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.copy(fromRel, toRel);
    await this.remove(fromRel);
  }

  async copy(fromRel: string, toRel: string): Promise<string[]> {
    const { client, bucket } = await this.getClient();
    const srcKey = cleanPath(fromRel);
    const destKey = cleanPath(toRel);
    const createdKeys: string[] = [];

    const head = await this.stat(srcKey);
    if (head) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${encodeURIComponent(srcKey)}`,
          Key: destKey,
        }),
      );
      createdKeys.push(destKey);
    } else {
      const prefix = srcKey.replace(/\/?$/, '/');
      let continuationToken: string | undefined = undefined;
      let isTruncated = true;
      while (isTruncated) {
        const list: ListObjectsV2CommandOutput = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        );
        if (list.Contents) {
          for (const item of list.Contents) {
            if (!item.Key) continue;
            const subKey = item.Key.substring(prefix.length);
            const targetKey = path.posix.join(destKey, subKey);
            await client.send(
              new CopyObjectCommand({
                Bucket: bucket,
                CopySource: `${bucket}/${encodeURIComponent(item.Key)}`,
                Key: targetKey,
              }),
            );
            createdKeys.push(targetKey);
          }
        }
        isTruncated = !!list.IsTruncated;
        continuationToken = list.NextContinuationToken;
      }
    }

    return createdKeys;
  }

  async remove(relPath: string): Promise<void> {
    const { client, bucket } = await this.getClient();
    const key = cleanPath(relPath);

    const prefix = key.replace(/\/?$/, '/');
    const list: ListObjectsV2CommandOutput = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    if (list.Contents && list.Contents.length > 0) {
      const keysToDelete = list.Contents.map((c) => ({ Key: c.Key! }));
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keysToDelete },
        }),
      );
    } else {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  }

  async trash(relPath: string): Promise<string> {
    const s = await getSettings();
    const trashDir = s.vault.trash || '.trash';
    const destRel = path.posix.join(trashDir, relPath);
    await this.rename(relPath, destRel);
    return destRel;
  }

  async listTrash(): Promise<TrashItem[]> {
    const s = await getSettings();
    const trashPrefix = (s.vault.trash || '.trash').replace(/\/?$/, '/');
    const { client, bucket } = await this.getClient();
    const out: TrashItem[] = [];

    let isTruncated = true;
    let continuationToken: string | undefined = undefined;
    while (isTruncated) {
      const res: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: trashPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      if (res.Contents) {
        for (const obj of res.Contents) {
          if (!obj.Key || obj.Key === trashPrefix) continue;
          const fileName = path.posix.basename(obj.Key);
          const original = obj.Key.substring(trashPrefix.length);
          out.push({
            name: fileName,
            path: obj.Key,
            original,
            ext: path.extname(fileName).toLowerCase(),
            size: obj.Size ?? 0,
            mtime: obj.LastModified ? obj.LastModified.getTime() : Date.now(),
          });
        }
      }
      isTruncated = !!res.IsTruncated;
      continuationToken = res.NextContinuationToken;
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async restoreFromTrash(trashRel: string): Promise<string> {
    const s = await getSettings();
    const trashPrefix = (s.vault.trash || '.trash').replace(/\/?$/, '/');
    const rel = cleanPath(trashRel);
    const destRel = rel.startsWith(trashPrefix) ? rel.substring(trashPrefix.length) : rel;
    await this.rename(rel, destRel);
    return destRel;
  }

  async deleteFromTrash(trashRel: string): Promise<void> {
    await this.remove(trashRel);
  }

  async emptyTrash(): Promise<void> {
    const s = await getSettings();
    const trashPrefix = (s.vault.trash || '.trash').replace(/\/?$/, '/');
    await this.remove(trashPrefix);
  }

  async getReadStream(relPath: string, start?: number, end?: number): Promise<{ stream: Readable; size: number }> {
    const { client, bucket } = await this.getClient();
    const key = cleanPath(relPath);

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const size = head.ContentLength ?? 0;

    const range = start !== undefined ? `bytes=${start}-${end ?? size - 1}` : undefined;
    const res = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: range,
      }),
    );

    if (!res.Body) {
      throw new Error(`Failed to get object stream for ${key}`);
    }

    const stream = res.Body as Readable;
    return { stream, size };
  }
}
