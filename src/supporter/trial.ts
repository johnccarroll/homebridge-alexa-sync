// 14-day first-run trial. On the first time the plugin loads on a given
// Homebridge install, we stamp a `.alexa-bridge-trial.json` marker in the
// storage directory. After 14 days, the plugin requires a valid supporter
// JWT to keep controlling devices — matches the `homebridge-alexa` verified
// precedent (7-day trial, then paid subscription).
//
// Anti-tamper posture is deliberately modest: the file is plain JSON and
// can be edited to reset the clock, but the plugin source is also visible
// and a determined cheat can just remove the check. The social contract,
// not the crypto, is what's holding this up — same as every other OSS
// Homebridge plugin that gates something.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TRIAL_DAYS = 14;
const FILE_NAME = '.alexa-bridge-trial.json';

export interface TrialState {
  firstRunAt: number; // epoch seconds
  daysElapsed: number;
  daysRemaining: number;
  expired: boolean;
}

interface TrialFile {
  firstRunAt: number;
  pluginVersion?: string;
}

/** Load trial state for this install, writing the marker file on first run. */
export function loadTrialState(
  storagePath: string,
  pluginVersion: string,
): TrialState {
  const filePath = join(storagePath, FILE_NAME);
  const nowSec = Math.floor(Date.now() / 1000);

  let firstRunAt: number;
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as TrialFile;
      if (typeof parsed.firstRunAt === 'number' && parsed.firstRunAt > 0) {
        firstRunAt = parsed.firstRunAt;
      } else {
        // Malformed — treat as first run
        firstRunAt = nowSec;
        writeTrialFile(filePath, firstRunAt, pluginVersion);
      }
    } catch {
      // Unreadable — treat as first run
      firstRunAt = nowSec;
      writeTrialFile(filePath, firstRunAt, pluginVersion);
    }
  } else {
    firstRunAt = nowSec;
    writeTrialFile(filePath, firstRunAt, pluginVersion);
  }

  const daysElapsed = Math.floor((nowSec - firstRunAt) / 86400);
  const daysRemaining = Math.max(0, TRIAL_DAYS - daysElapsed);
  const expired = daysElapsed >= TRIAL_DAYS;

  return { firstRunAt, daysElapsed, daysRemaining, expired };
}

function writeTrialFile(
  filePath: string,
  firstRunAt: number,
  pluginVersion: string,
): void {
  try {
    writeFileSync(
      filePath,
      JSON.stringify({ firstRunAt, pluginVersion } satisfies TrialFile, null, 2),
      'utf8',
    );
  } catch {
    // If we can't write, the trial still "works" — on next startup we'll
    // just re-compute as if it were first run. Not ideal, but not fatal.
  }
}

export const TRIAL_DAYS_CONST = TRIAL_DAYS;
