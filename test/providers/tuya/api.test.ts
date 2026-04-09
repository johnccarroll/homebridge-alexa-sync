import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuyaApi } from '../../../src/providers/tuya/api.js';

describe('TuyaApi', () => {
  describe('signing', () => {
    it('generates correct HMAC-SHA256 signature for token request', () => {
      const api = new TuyaApi({
        accessId: 'test_client_id',
        accessKey: 'test_secret',
        region: 'us',
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: {
            access_token: 'mock_token',
            expire_time: 7200,
            refresh_token: 'mock_refresh',
            uid: 'mock_uid',
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      return api.getToken().then(() => {
        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe('https://openapi.tuyaus.com/v1.0/token?grant_type=1');
        expect(options.headers.client_id).toBe('test_client_id');
        expect(options.headers.sign_method).toBe('HMAC-SHA256');
        expect(options.headers.sign).toMatch(/^[A-F0-9]{64}$/);
        expect(options.headers.t).toMatch(/^\d+$/);
      });
    });
  });

  describe('region URLs', () => {
    it.each([
      ['us', 'https://openapi.tuyaus.com'],
      ['eu', 'https://openapi.tuyaeu.com'],
      ['cn', 'https://openapi.tuyacn.com'],
      ['in', 'https://openapi.tuyain.com'],
    ] as const)('maps region %s to %s', (region, expected) => {
      const api = new TuyaApi({ accessId: 'x', accessKey: 'x', region });
      expect(api.baseUrl).toBe(expected);
    });
  });

  describe('getToken', () => {
    it('stores token and uid on success', async () => {
      const api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: {
            access_token: 'tok_123',
            expire_time: 7200,
            refresh_token: 'ref_456',
            uid: 'uid_789',
          },
        }),
      }));

      await api.getToken();
      expect(api.accessToken).toBe('tok_123');
      expect(api.uid).toBe('uid_789');
    });

    it('throws on API error', async () => {
      const api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, code: 1004, msg: 'sign invalid' }),
      }));

      await expect(api.getToken()).rejects.toThrow('sign invalid');
    });
  });

  describe('getDevices', () => {
    let api: TuyaApi;

    beforeEach(async () => {
      api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      api.accessToken = 'tok_123';
      api.uid = 'uid_789';
    });

    it('returns device list', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: [{
            id: 'dev_001',
            name: 'Kitchen Light',
            category: 'dj',
            online: true,
            product_id: 'prod_1',
            status: [
              { code: 'switch_led', value: true },
              { code: 'bright_value_v2', value: 500 },
            ],
          }],
        }),
      }));

      const devices = await api.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('dev_001');
      expect(devices[0].name).toBe('Kitchen Light');
    });
  });

  describe('sendCommands', () => {
    let api: TuyaApi;

    beforeEach(() => {
      api = new TuyaApi({ accessId: 'x', accessKey: 'x', region: 'us' });
      api.accessToken = 'tok_123';
      api.uid = 'uid_789';
    });

    it('sends POST with commands body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, result: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await api.sendCommands('dev_001', [
        { code: 'switch_led', value: true },
      ]);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://openapi.tuyaus.com/v1.0/devices/dev_001/commands');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        commands: [{ code: 'switch_led', value: true }],
      });
    });
  });
});
