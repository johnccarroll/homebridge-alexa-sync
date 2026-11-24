# AGENTS.md

Notes for anyone (human or agent) changing this plugin. User-facing setup is in README.md.

## Build and test

```bash
npm install && npm run build && npm test
```

TypeScript / ESM, Node 20/22/24, Homebridge 1.8+ and 2.x. Two runtime dependencies only:
`alexa-remote2` and `alexa-cookie2`.

## Gotchas

- **`alexa-remote2` is CommonJS.** Import it with `createRequire(import.meta.url)`.
- **alexa-cookie2 starts its login proxy even with `setupProxy: false`.** That flag sits in the
  `else` of "were credentials supplied", and `proxyListenBind` is only defaulted inside the branch
  it skips, so the proxy binds every interface. The plugin pins it to loopback *and* calls
  `stopProxyServer()` on failure; both halves are needed.
- **alexa-cookie2's logger prints full cookie jars** in three formats. All three are redacted;
  keep it that way when touching logging.
- **Cookie file is mode 0600.** A root-owned cookie is unreadable by Homebridge, so the plugin
  tells `EACCES` apart from "no cookie", and the login script chowns to the storage directory's
  owner when run as root.
- **Colour temperature:** HomeKit uses mireds (`1000000 / kelvin`), Alexa uses kelvin; the mapper
  converts. Set a default value before `setProps` to avoid Homebridge warnings.
- **Homebridge 2.0** bridges accessories on construction, so `registerPlatformAccessories` can
  throw "already bridged". It is caught and ignored on purpose.
- State reads and control use Amazon's GraphQL API (0.4.0); rediscovery runs every 10 minutes.

## Installing a build on a Raspberry Pi

The Pi image's bundled `npm` fails with "Class extends value undefined is not a constructor", so
install from the packed tarball instead of `npm install`:

```bash
npm run build && npm pack
scp homebridge-alexa-sync-<v>.tgz <host>:/tmp/
ssh <host> '
  P=/var/lib/homebridge/node_modules/homebridge-alexa-sync
  cd /tmp && rm -rf pkgx && mkdir pkgx && tar xzf homebridge-alexa-sync-<v>.tgz -C pkgx
  rm -rf "$P/dist" && cp -R pkgx/package/dist "$P/dist"
  cp pkgx/package/package.json pkgx/package/config.schema.json pkgx/package/README.md "$P/"
  cp -R pkgx/package/scripts "$P/" && rm -rf pkgx'
ssh <host> 'sudo systemctl restart homebridge'
```

## Releasing

npm Trusted Publishing through GitHub Actions OIDC; no token is stored. `package.json`
`repository.url` must match the configured repository exactly, or publishing fails without a
clear error. Bump the version, commit, then:

```bash
git tag vX.Y.Z && git push origin main --tags
```
