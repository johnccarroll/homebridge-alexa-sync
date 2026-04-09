import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { DeviceManager } from './device-manager.js';
import { handleAlexaDirective } from './alexa-skill/handler.js';
import type { AlexaStateReporter } from './alexa-skill/state-reporter.js';

interface ApiServerConfig {
  port: number;
  apiKey: string;
  stateReporter?: AlexaStateReporter;
}

export class ApiServer {
  private server: Server | null = null;
  private readonly dm: DeviceManager;
  private readonly config: ApiServerConfig;

  constructor(dm: DeviceManager, config: ApiServerConfig) {
    this.dm = dm;
    this.config = config;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.config.port, '0.0.0.0', () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers['x-api-key'] !== this.config.apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/devices') {
        const devices = this.dm.getAllDevices();
        this.json(res, 200, devices);
      } else if (req.method === 'GET' && path.match(/^\/devices\/(.+)\/state$/)) {
        const deviceId = decodeURIComponent(path.match(/^\/devices\/(.+)\/state$/)![1]);
        const device = this.dm.getDevice(deviceId);
        if (!device) {
          this.json(res, 404, { error: 'Device not found' });
          return;
        }
        const state = await this.dm.getState(deviceId);
        this.json(res, 200, state);
      } else if (req.method === 'PUT' && path.match(/^\/devices\/(.+)\/state$/)) {
        const deviceId = decodeURIComponent(path.match(/^\/devices\/(.+)\/state$/)![1]);
        const device = this.dm.getDevice(deviceId);
        if (!device) {
          this.json(res, 404, { error: 'Device not found' });
          return;
        }
        const body = await this.readBody(req);
        const state = JSON.parse(body);
        await this.dm.setState(deviceId, state);
        this.json(res, 200, { ok: true });
      } else if (req.method === 'POST' && path === '/alexa/directive') {
        const body = await this.readBody(req);
        let event: any;
        try {
          event = JSON.parse(body);
        } catch {
          this.json(res, 400, { error: 'Invalid JSON' });
          return;
        }
        if (!event?.directive?.header?.namespace) {
          this.json(res, 400, { error: 'Invalid Alexa directive' });
          return;
        }
        const response = await handleAlexaDirective(event, this.dm, this.config.stateReporter);
        this.json(res, 200, response);
      } else {
        this.json(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      this.json(res, 500, { error: (err as Error).message });
    }
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}
