// Plugin-side Supabase Realtime client. Subscribes to the directives
// table for the signed-in sponsor + project, dispatches each incoming
// directive to the existing Alexa handler, writes the response back to
// the same row. Vercel's Alexa-skill endpoint sees the UPDATE via its
// own Realtime subscription and returns to Amazon.
//
// Activates only when a valid supporter JWT is present in config. In
// free mode the client is never created — plugin runs Alexa-cookie
// only.

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'homebridge';

import type { DeviceManager } from '../device-manager.js';
import { handleAlexaDirective } from '../alexa-skill/handler.js';

const SUPABASE_URL = 'https://wvbsupxcrukpolkiuzll.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_zmdqf4VfmVQIhdtscordIQ_T8UaW5-R';
const PROJECT_ID = 'switchboard';

interface DirectiveRow {
  id: string;
  project_id: string;
  user_id: string;
  request_id: string;
  directive_json: Record<string, unknown>;
  response_json: Record<string, unknown> | null;
}

// How many consecutive CHANNEL_ERROR / TIMED_OUT events to tolerate before
// we suspect the supporter JWT has expired or rotated and tell the user to
// refresh it. Each Realtime auto-reconnect attempt fires one event, so this
// caps the noise floor before the actionable warning surfaces.
const CHANNEL_ERROR_THRESHOLD = 5;

export class CloudClient {
  private readonly supabase: SupabaseClient;
  private readonly deviceManager: DeviceManager;
  private readonly log: Logger;
  private readonly installId: string;
  private channel?: RealtimeChannel;
  private channelErrorCount = 0;
  private reauthWarned = false;

  constructor(options: {
    supporterToken: string;
    installId: string;
    deviceManager: DeviceManager;
    log: Logger;
  }) {
    this.deviceManager = options.deviceManager;
    this.log = options.log;
    this.installId = options.installId;

    this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: {
          // Supabase Realtime auth: session token carries project + sub claims
          // that the server-side RLS policies filter on.
          Authorization: `Bearer ${options.supporterToken}`,
        },
      },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }

  async start(): Promise<void> {
    // Subscribe to INSERTs on directives; RLS scopes to our user_id automatically.
    this.channel = this.supabase
      .channel(`directives-${this.installId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'directives', filter: `project_id=eq.${PROJECT_ID}` },
        (payload: { new: DirectiveRow }) => {
          void this.handleDirective(payload.new);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (this.channelErrorCount > 0) {
            this.log.info('Cloud client: subscription recovered.');
          } else {
            this.log.info(`Cloud client: subscribed (install=${this.installId.slice(0, 8)})`);
          }
          this.channelErrorCount = 0;
          this.reauthWarned = false;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.channelErrorCount++;
          if (this.channelErrorCount === 1) {
            this.log.warn(`Cloud client: subscription ${status}. Will auto-retry.`);
          } else if (this.channelErrorCount >= CHANNEL_ERROR_THRESHOLD && !this.reauthWarned) {
            // After this many failed reconnects the most likely cause is an
            // expired supporter token. Auto-refresh isn't supported here
            // (token comes from config; rotating it requires the user); say
            // so explicitly so the user knows what to do.
            this.reauthWarned = true;
            this.log.warn(
              `Cloud client: ${this.channelErrorCount} consecutive ${status} events — ` +
              'supporter token has likely expired. Get a fresh token at ' +
              'https://cloud.johncarroll.dev/switchboard, paste it into the ' +
              "plugin's `supporter.token` config field, and restart Homebridge.",
            );
          }
        }
      });
  }

  async stop(): Promise<void> {
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
      this.channel = undefined;
    }
  }

  /** Receive directive → dispatch to existing handler → UPDATE response. */
  private async handleDirective(row: DirectiveRow): Promise<void> {
    this.log.debug(`Cloud directive ${row.request_id}: ${JSON.stringify(row.directive_json).slice(0, 100)}`);

    // I1 mitigation: claim the directive atomically before processing. With
    // multiple installs subscribed to the same project_id channel, every
    // plugin sees every INSERT. Without a claim, both would call setState
    // on the underlying smart-home device (locks click twice, lights flicker)
    // before one "wins" the UPDATE. We use the existing responded_at column
    // as the claim marker: only the first UPDATE-with-IS-NULL precondition
    // returns rows; the loser sees rowCount=0 and skips.
    const claim = await this.supabase
      .from('directives')
      .update({ responded_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('responded_at', null)
      .select('id');
    if (claim.error) {
      this.log.warn(`Cloud directive ${row.request_id} claim failed: ${claim.error.message}`);
      return;
    }
    if (!claim.data || claim.data.length === 0) {
      this.log.debug(`Cloud directive ${row.request_id}: another install already claimed`);
      return;
    }

    let response: Record<string, unknown>;
    try {
      response = (await handleAlexaDirective(
        row.directive_json as Parameters<typeof handleAlexaDirective>[0],
        this.deviceManager,
      )) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Cloud directive ${row.request_id} failed: ${msg}`);
      response = {
        event: {
          header: { namespace: 'Alexa', name: 'ErrorResponse', payloadVersion: '3' },
          payload: { type: 'INTERNAL_ERROR', message: msg },
        },
      };
    }

    const { error } = await this.supabase
      .from('directives')
      .update({ response_json: response })
      .eq('id', row.id);
    if (error) {
      this.log.warn(`Cloud directive ${row.request_id} UPDATE failed: ${error.message}`);
    }
  }
}
