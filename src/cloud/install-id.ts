// Per-install UUID. Generated on first startup and persisted to the
// Homebridge storage directory. Used to deduplicate connections when the
// same sponsor JWT is deployed on multiple Homebridge installations —
// the cloud keeps only the most-recent install_id's WebSocket alive,
// older ones get DUPLICATE_CONNECTION errors.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const FILE_NAME = '.alexa-bridge-install-id';

export function loadOrCreateInstallId(storagePath: string): string {
  const path = join(storagePath, FILE_NAME);
  if (existsSync(path)) {
    try {
      const id = readFileSync(path, 'utf8').trim();
      if (id.length > 0) return id;
    } catch {
      // fall through to regenerate
    }
  }
  const id = randomUUID();
  try {
    writeFileSync(path, id, 'utf8');
  } catch {
    // If we can't write, we still return a valid id for this session.
    // On next startup a new id will be generated — acceptable fallback.
  }
  return id;
}
