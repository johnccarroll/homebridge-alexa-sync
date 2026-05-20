import { renameSync, writeFileSync, type WriteFileOptions } from 'node:fs';

/**
 * Write a file as atomically as POSIX allows: write to a sibling `.tmp` path,
 * then rename(2) into place. rename(2) is atomic on POSIX filesystems — a
 * reader either sees the old file or the new file, never a half-written one.
 * Process death between write and rename leaves a stale `.tmp` lying around;
 * leaves the real file untouched. Same options shape as writeFileSync.
 */
export function atomicWrite(path: string, data: string | Uint8Array, options?: WriteFileOptions): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, options);
  renameSync(tmp, path);
}
