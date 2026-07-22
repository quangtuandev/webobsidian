import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { getStorageProvider } from './storage/index.js';

/**
 * Serve a binary file with HTTP Range support so embedded `<video>`/`<audio>`
 * can seek: browsers (Safari especially) request `Range: bytes=…` and need a
 * 206 partial response, otherwise the scrubber and playback break. Streams the
 * file instead of buffering it — vault media can be hundreds of MB.
 */
export async function sendFileWithRange(
  req: Request,
  res: Response,
  targetPath: string,
  mime: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const provider = await getStorageProvider();

  let size = 0;
  let getStream: (start?: number, end?: number) => Promise<any>;

  if (provider.getProviderType() === 'r2') {
    const st = await provider.stat(targetPath);
    if (!st) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    size = st.size;
    getStream = async (start?: number, end?: number) => {
      const { stream } = await provider.getReadStream(targetPath, start, end);
      return stream;
    };
  } else {
    // Local storage fallback (targetPath can be absolute path or rel path)
    try {
      const st = await stat(targetPath);
      size = st.size;
      getStream = async (start?: number, end?: number) => {
        const opts: { start?: number; end?: number } = {};
        if (start !== undefined) opts.start = start;
        if (end !== undefined) opts.end = end;
        return createReadStream(targetPath, opts);
      };
    } catch {
      const st = await provider.stat(targetPath);
      if (!st) {
        res.status(404).json({ error: 'file not found' });
        return;
      }
      size = st.size;
      getStream = async (start?: number, end?: number) => {
        const { stream } = await provider.getReadStream(targetPath, start, end);
        return stream;
      };
    }
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    if (!Number.isFinite(start) || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    const stream = await getStream(start, end);
    stream.pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  const stream = await getStream();
  stream.pipe(res);
}
