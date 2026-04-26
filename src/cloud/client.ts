// Plugin-side Supabase Realtime client. Subscribes to the directives
// table for the signed-in sponsor + project, dispatches each incoming
// directive to the existing Alexa handler, writes the response back to
// the same row. Vercel's Alexa-skill endpoint sees the UPDATE via its
// own Realtime subscription and returns to Amazon.
//
// Activates only when a valid supporter JWT is present in config. In
// free mode the client is never created — plugin operates fully
// offline-capable (Tuya + Alexa cookie + Resideo providers working
// locally).

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

export class CloudClient {
  private readonly supabase: SupabaseClient;
  private readonly deviceManager: DeviceManager;
  private readonly log: Logger;
  private readonly installId: string;
  private channel?: RealtimeChannel;

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
          this.log.info(`Cloud client: subscribed (install=${this.installId.slice(0, 8)})`);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.log.warn(`Cloud client: subscription ${status}. Will auto-retry.`);
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

    let response: Record<string, unknown>;
    try {
      response = (await handleAlexaDirective(
        row.directive_json as Parameters<typeof handleAlexaDirective>[0],
        this.deviceManager,
        undefined, // stateReporter — cloud handles proactive reports via /alexa/state-change
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
      .update({ response_json: response, responded_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) {
      this.log.warn(`Cloud directive ${row.request_id} UPDATE failed: ${error.message}`);
    }
  }
}
