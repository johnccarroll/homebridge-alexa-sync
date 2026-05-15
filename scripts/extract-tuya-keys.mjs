#!/usr/bin/env node
// One-time extraction of Tuya local keys + device metadata.
//
// Usage:
//   node scripts/extract-tuya-keys.mjs > /var/lib/homebridge/tuya-local.json
//
// Reads cloud credentials from these env vars (or pass --access-id, --access-key,
// --region):
//   TUYA_ACCESS_ID, TUYA_ACCESS_KEY, TUYA_REGION (us|eu|cn|in, default us)
//
// Run this once while your Tuya IoT Core trial is active. The output is the
// `tuya-local.json` file the plugin reads on startup. After that, cloud
// expiry doesn't affect local control.

import { TuyaApi } from '../dist/providers/tuya/api.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const accessId = arg('--access-id', process.env.TUYA_ACCESS_ID);
const accessKey = arg('--access-key', process.env.TUYA_ACCESS_KEY);
const region = arg('--region', process.env.TUYA_REGION ?? 'us');

if (!accessId || !accessKey) {
  console.error('Missing credentials. Set TUYA_ACCESS_ID + TUYA_ACCESS_KEY or pass --access-id / --access-key.');
  process.exit(2);
}

const api = new TuyaApi({ accessId, accessKey, region });

try {
  process.stderr.write('Fetching device list... ');
  const devices = await api.getDevices();
  process.stderr.write(`${devices.length} devices.\n`);

  process.stderr.write('Fetching factory infos (local keys)... ');
  const infos = await api.getFactoryInfos(devices.map(d => d.id));
  const keyById = new Map(infos.map(i => [i.id, i.local_key]));
  process.stderr.write(`${keyById.size} keys.\n`);

  const out = devices
    .map(d => {
      const localKey = keyById.get(d.id);
      if (!localKey) {
        process.stderr.write(`  skip ${d.name} (${d.id}) — no local_key returned\n`);
        return null;
      }
      return {
        id: d.id,
        name: d.name,
        category: d.category,
        productId: d.product_id,
        localKey,
      };
    })
    .filter(Boolean);

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`\nWrote ${out.length} devices. Save the JSON to <homebridge-storage>/tuya-local.json.\n`);
} catch (err) {
  console.error('Extraction failed:', err.message ?? err);
  process.exit(1);
}
