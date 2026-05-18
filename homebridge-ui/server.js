// Homebridge Custom UI server — Alexa sign-in flow.
//
// Lives next to the plugin in the Homebridge UI process. Exposes three
// endpoints to the frontend (homebridge-ui/public/index.html):
//   /status        → cookie present? when refreshed?
//   /start-login   → spin up alexa-cookie2 proxy, return the URL to open
//   /logout        → delete the cookie file
//
// The proxy is bound to the same host the user is browsing the Homebridge
// UI from (passed in as `browserHost`), so the `proxyOwnIp` in the cookie
// library matches what the user actually opens — eliminating the common
// "QR-code redirected me to alexa.amazon.com" failure mode caused by a
// hardcoded proxy IP.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const alexaCookie = require('alexa-cookie2');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

const COOKIE_FILENAME = '.alexa-sync-cookie.json';
const DEFAULT_AMAZON_PAGE = 'amazon.com';
const DEFAULT_PROXY_PORT = 3456;

class AlexaSyncUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.cookiePath = path.join(this.homebridgeStoragePath, COOKIE_FILENAME);
    this.pendingProxy = null;

    this.onRequest('/status', this.handleStatus.bind(this));
    this.onRequest('/start-login', this.handleStartLogin.bind(this));
    this.onRequest('/logout', this.handleLogout.bind(this));

    this.ready();
  }

  handleStatus() {
    try {
      const stat = fs.statSync(this.cookiePath);
      const raw = JSON.parse(fs.readFileSync(this.cookiePath, 'utf8'));
      return {
        hasCookie: true,
        mtime: stat.mtimeMs,
        amazonPage: raw.amazonPage ?? DEFAULT_AMAZON_PAGE,
        pendingLogin: !!this.pendingProxy,
      };
    } catch {
      return { hasCookie: false, pendingLogin: !!this.pendingProxy };
    }
  }

  async handleStartLogin(payload) {
    const browserHost = payload?.browserHost;
    const amazonPage = payload?.amazonPage ?? DEFAULT_AMAZON_PAGE;
    const proxyPort = Number(payload?.proxyPort) || DEFAULT_PROXY_PORT;

    if (!browserHost) {
      throw new RequestError('browserHost required — frontend must pass window.location.hostname');
    }
    if (this.pendingProxy) {
      return { loginUrl: this.pendingProxy.loginUrl, alreadyRunning: true };
    }

    const loginUrl = `http://${browserHost}:${proxyPort}/`;

    // alexa-cookie2 starts an HTTP proxy on proxyOwnIp:proxyPort. The user
    // visits that URL in their browser; the lib rewrites links so Amazon's
    // login flow round-trips through the proxy and the final cookie is
    // captured. Resolves with full cookie data on success.
    const options = {
      logger: (msg) => { /* swallow library chatter — surface only on error */ },
      amazonPage,
      acceptLanguage: 'en-US',
      proxyOwnIp: browserHost,
      proxyPort,
      proxyListenBind: '0.0.0.0',
      proxyOnly: true,
    };

    const promise = new Promise((resolve, reject) => {
      alexaCookie.generateAlexaCookie('', '', options, (err, result) => {
        if (err && !result) return reject(err);
        if (!result?.localCookie && !result?.cookie) {
          return reject(new Error('alexa-cookie2 returned without a cookie'));
        }
        try {
          const toSave = { ...result, amazonPage };
          fs.writeFileSync(this.cookiePath, JSON.stringify(toSave));
          resolve(toSave);
        } catch (writeErr) {
          reject(writeErr);
        }
      });
    });

    this.pendingProxy = { loginUrl, promise };
    promise.finally(() => {
      this.pendingProxy = null;
    }).catch(() => { /* status endpoint will reflect absence */ });

    // Push a one-shot event when login completes so the frontend can update
    // without polling forever.
    promise.then(
      () => this.pushEvent('alexa-login-complete', { ok: true }),
      (err) => this.pushEvent('alexa-login-complete', { ok: false, error: String(err?.message ?? err) }),
    );

    return { loginUrl, alreadyRunning: false };
  }

  handleLogout() {
    try {
      fs.unlinkSync(this.cookiePath);
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true };
      throw new RequestError(`Could not delete cookie: ${err.message}`);
    }
  }
}

new AlexaSyncUiServer();
