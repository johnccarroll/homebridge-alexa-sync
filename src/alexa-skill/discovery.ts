import type { BridgeDevice, DeviceType } from '../types.js';
import { randomUUID } from 'node:crypto';

const DEVICE_TYPE_TO_CATEGORY: Record<DeviceType, string> = {
  light: 'LIGHT',
  switch: 'SWITCH',
  outlet: 'SMARTPLUG',
  lock: 'SMARTLOCK',
  fan: 'FAN',
  thermostat: 'THERMOSTAT',
};

function buildCapabilities(device: BridgeDevice): object[] {
  const caps: object[] = [];
  caps.push({ type: 'AlexaInterface', interface: 'Alexa', version: '3' });
  caps.push({
    type: 'AlexaInterface',
    interface: 'Alexa.EndpointHealth',
    version: '3',
    properties: {
      supported: [{ name: 'connectivity' }],
      proactivelyReported: false,
      retrievable: true,
    },
  });

  for (const cap of device.capabilities) {
    switch (cap.type) {
      case 'on-off':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.PowerController', version: '3',
          properties: { supported: [{ name: 'powerState' }], proactivelyReported: false, retrievable: true },
        });
        break;
      case 'brightness':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.BrightnessController', version: '3',
          properties: { supported: [{ name: 'brightness' }], proactivelyReported: false, retrievable: true },
        });
        break;
      case 'color':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.ColorController', version: '3',
          properties: { supported: [{ name: 'color' }], proactivelyReported: false, retrievable: true },
        });
        break;
      case 'color-temperature':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.ColorTemperatureController', version: '3',
          properties: { supported: [{ name: 'colorTemperatureInKelvin' }], proactivelyReported: false, retrievable: true },
        });
        break;
      case 'temperature':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.TemperatureSensor', version: '3',
          properties: { supported: [{ name: 'temperature' }], proactivelyReported: false, retrievable: true },
        });
        break;
      case 'target-temperature':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.ThermostatController', version: '3',
          properties: {
            supported: [{ name: 'targetSetpoint' }, { name: 'thermostatMode' }],
            proactivelyReported: false,
            retrievable: true,
          },
        });
        break;
      case 'lock':
        caps.push({
          type: 'AlexaInterface', interface: 'Alexa.LockController', version: '3',
          properties: { supported: [{ name: 'lockState' }], proactivelyReported: false, retrievable: true },
        });
        break;
    }
  }
  return caps;
}

export function buildDiscoveryResponse(devices: BridgeDevice[]): any {
  const endpoints = devices.map(device => ({
    endpointId: device.id,
    manufacturerName: device.manufacturer ?? 'Homebridge',
    description: `${device.name} via Alexa Bridge`,
    friendlyName: device.name,
    displayCategories: [DEVICE_TYPE_TO_CATEGORY[device.type] ?? 'OTHER'],
    capabilities: buildCapabilities(device),
  }));

  return {
    event: {
      header: { namespace: 'Alexa.Discovery', name: 'Discover.Response', payloadVersion: '3', messageId: randomUUID() },
      payload: { endpoints },
    },
  };
}
