# AriaKey License Server

`AriaKey` desktop app already calls:

- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`

This service implements those endpoints, stores license state in SQLite, and provides admin tooling to issue/revoke keys.

## 1. Quick start

```bash
cd services/license-server
cp .env.example .env
npm install
npm run init-db
npm start
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## 2. Issue license keys (seller side)

Issue one license:

```bash
cd services/license-server
npm run admin -- issue --email buyer@example.com --order ord_123 --days 365 --max 2
```

You will get output like:

```txt
LICENSE_KEY=AK-7M3Q-A9K2-H8TR-W4NP
```

Inspect:

```bash
npm run admin -- inspect --key AK-7M3Q-A9K2-H8TR-W4NP
```

Revoke:

```bash
npm run admin -- revoke --key AK-7M3Q-A9K2-H8TR-W4NP --reason "Refunded"
```

## 3. Wire AriaKey app to this server

Set desktop app env (`.env` in app userData or packaged env):

```bash
LICENSE_API_BASE_URL=https://license.your-domain.com
LICENSE_PRODUCT_ID=ariakey-pro
LICENSE_OFFLINE_GRACE_HOURS=168
```

Then customers can activate from `Settings -> Account -> Desktop License`.

## 4. API examples

Activate:

```bash
curl -X POST http://127.0.0.1:8787/v1/licenses/activate \
  -H "Content-Type: application/json" \
  -d '{
    "licenseKey":"AK-7M3Q-A9K2-H8TR-W4NP",
    "productId":"ariakey-pro",
    "machineId":"abc123-machine-fingerprint",
    "appVersion":"1.5.11",
    "platform":"darwin",
    "arch":"arm64"
  }'
```

Validate:

```bash
curl -X POST http://127.0.0.1:8787/v1/licenses/validate \
  -H "Content-Type: application/json" \
  -d '{
    "licenseKey":"AK-7M3Q-A9K2-H8TR-W4NP",
    "productId":"ariakey-pro",
    "machineId":"abc123-machine-fingerprint",
    "appVersion":"1.5.11",
    "platform":"darwin",
    "arch":"arm64"
  }'
```

## 5. Production checklist

- Use HTTPS.
- Set a strong `LICENSE_KEY_PEPPER`.
- Restrict server access with firewall/rate limiting.
- Keep `services/license-server/.env` out of git.
- Back up `data/licenses.db`.
- For payment automation, call `npm run admin -- issue ...` logic from your payment webhook worker.

