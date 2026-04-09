import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlexaStateReporter } from '../../src/alexa-skill/state-reporter.js';

describe('AlexaStateReporter', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not enabled without tokens', () => {
    const reporter = new AlexaStateReporter('client-id', 'client-secret');
    expect(reporter.isEnabled).toBe(false);
  });

  it('is enabled after restoring tokens', () => {
    const reporter = new AlexaStateReporter('client-id', 'client-secret');
    reporter.restoreTokens({
      accessToken: 'tok',
      refreshToken: 'ref',
      tokenExpiry: Date.now() + 3600_000,
    });
    expect(reporter.isEnabled).toBe(true);
  });

  it('handles AcceptGrant by exchanging code for tokens', async () => {
    const reporter = new AlexaStateReporter('client-id', 'client-secret');
    const persistSpy = vi.fn();
    reporter.onPersist(persistSpy);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    }));

    await reporter.handleAcceptGrant('auth-code-123');
    expect(reporter.isEnabled).toBe(true);
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
    );
  });

  it('sends ChangeReport to Event Gateway', async () => {
    const reporter = new AlexaStateReporter('client-id', 'client-secret');
    reporter.restoreTokens({
      accessToken: 'tok',
      refreshToken: 'ref',
      tokenExpiry: Date.now() + 3600_000,
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await reporter.sendChangeReport('device-1', { on: true }, { on: true, brightness: 50 });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.amazonalexa.com/v3/events',
      expect.objectContaining({ method: 'POST' }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event.header.name).toBe('ChangeReport');
    expect(body.event.payload.change.properties[0].value).toBe('ON');
  });

  it('skips ChangeReport when not enabled', async () => {
    const reporter = new AlexaStateReporter('client-id', 'client-secret');
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await reporter.sendChangeReport('device-1', { on: true }, { on: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
