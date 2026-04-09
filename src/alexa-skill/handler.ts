import type { DeviceManager } from '../device-manager.js';
import { buildDiscoveryResponse } from './discovery.js';
import { extractStateFromDirective, buildControlResponse, buildStateReportResponse } from './control.js';
import { randomUUID } from 'node:crypto';
import type { AlexaStateReporter } from './state-reporter.js';

export async function handleAlexaDirective(event: any, dm: DeviceManager, stateReporter?: AlexaStateReporter): Promise<any> {
  const directive = event.directive;
  const { namespace, name, correlationToken } = directive.header;

  // AcceptGrant — exchange auth code for LWA tokens
  if (namespace === 'Alexa.Authorization' && name === 'AcceptGrant') {
    if (!stateReporter) {
      return buildErrorResponse('ACCEPT_GRANT_FAILED', 'State reporter not configured');
    }
    try {
      const code = directive.payload?.grant?.code;
      if (!code) throw new Error('Missing grant code');
      await stateReporter.handleAcceptGrant(code);
      return {
        event: {
          header: {
            namespace: 'Alexa.Authorization',
            name: 'AcceptGrant.Response',
            payloadVersion: '3',
            messageId: randomUUID(),
          },
          payload: {},
        },
      };
    } catch (err) {
      return buildErrorResponse('ACCEPT_GRANT_FAILED', (err as Error).message);
    }
  }

  if (namespace === 'Alexa.Discovery' && name === 'Discover') {
    const devices = dm.getAllDevices();
    return buildDiscoveryResponse(devices);
  }

  if (namespace === 'Alexa' && name === 'ReportState') {
    const endpointId = directive.endpoint.endpointId;
    try {
      const state = await dm.getState(endpointId);
      return buildStateReportResponse(endpointId, correlationToken, state);
    } catch {
      return buildErrorResponse('NO_SUCH_ENDPOINT', `Device ${endpointId} not found`, correlationToken, endpointId);
    }
  }

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse('INVALID_DIRECTIVE', 'Missing endpoint', correlationToken);
  }

  try {
    const stateChange = extractStateFromDirective(directive);
    if (Object.keys(stateChange).length > 0) {
      await dm.setState(endpointId, stateChange);
    }
    const currentState = await dm.getState(endpointId);
    return buildControlResponse(endpointId, correlationToken, currentState);
  } catch (err) {
    return buildErrorResponse('ENDPOINT_UNREACHABLE', (err as Error).message, correlationToken, endpointId);
  }
}

function buildErrorResponse(type: string, message: string, correlationToken?: string, endpointId?: string): any {
  const response: any = {
    event: {
      header: { namespace: 'Alexa', name: 'ErrorResponse', payloadVersion: '3', messageId: randomUUID() },
      payload: { type, message },
    },
  };
  if (correlationToken) response.event.header.correlationToken = correlationToken;
  if (endpointId) response.event.endpoint = { endpointId };
  return response;
}
