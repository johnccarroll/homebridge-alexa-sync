// alexa-lambda/index.mjs
// Thin proxy — forwards Alexa Smart Home directives to the plugin's API server.
// Set BRIDGE_URL and BRIDGE_API_KEY as Lambda environment variables.

const BRIDGE_URL = process.env.BRIDGE_URL; // e.g., 'http://100.x.x.x:9090'
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

export const handler = async (event) => {
  if (!BRIDGE_URL) {
    return errorResponse('INTERNAL_ERROR', 'BRIDGE_URL not configured');
  }

  // Forward all directives to the plugin's API server
  const res = await fetch(`${BRIDGE_URL}/alexa/directive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': BRIDGE_API_KEY,
    },
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    return errorResponse('ENDPOINT_UNREACHABLE', 'Bridge unreachable');
  }

  return res.json();
};

function errorResponse(type, message) {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        payloadVersion: '3',
        messageId: crypto.randomUUID(),
      },
      payload: { type, message },
    },
  };
}
