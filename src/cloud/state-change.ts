// Fire proactive state-change events to the cloud so Alexa sees updates
// within seconds of a HomeKit/Tuya-app/physical-switch change. Rate-
// limits per-device at 500ms so rapid toggles coalesce into one event.
//
// The cloud handles the actual Alexa ChangeReport POST (holds LWA
// tokens, refreshes them, etc). Plugin just fires-and-forgets here.

import type { Logger } from 'homebridge';

import type { DeviceState } from '../types.js';

const STATE_CHANGE_URL = 'https://cloud.johncarroll.dev/switchboard/alexa/state-change';
const COALESCE_MS = 500;

export class StateChangePublisher {
  private readonly supporterToken: string;
  private readonly log: Logger;
  private readonly pending = new Map<string, { state: DeviceState; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: { supporterToken: string; log: Logger }) {
    this.supporterToken = options.supporterToken;
    this.log = options.log;
  }

  /** Called from DeviceManager's onStateChange hook. Coalesces rapid
   *  sequential updates per device into a single POST. */
  publish(deviceId: string, state: DeviceState): void {
    const existing = this.pending.get(deviceId);
    if (existing) {
      clearTimeout(existing.timer);
      // Merge the latest state on top of any buffered
      existing.state = { ...existing.state, ...state };
    }
    const buffered: DeviceState = existing ? existing.state : { ...state };
    const timer = setTimeout(() => {
      this.pending.delete(deviceId);
      void this.send(deviceId, buffered);
    }, COALESCE_MS);
    this.pending.set(deviceId, { state: buffered, timer });
  }

  /** Cancel all pending debounced posts; used on plugin shutdown. */
  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private async send(deviceId: string, state: DeviceState): Promise<void> {
    try {
      const res = await fetch(STATE_CHANGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.supporterToken}`,
        },
        body: JSON.stringify({ deviceId, state }),
      });
      if (!res.ok) {
        this.log.debug(`state-change POST ${res.status} for ${deviceId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(`state-change POST failed for ${deviceId}: ${msg}`);
      // Best-effort — no retry. Next state change re-sends anyway.
    }
  }
}
