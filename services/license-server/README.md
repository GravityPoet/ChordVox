# ChordVox License Server

`ChordVox` desktop app already calls:

- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`

This service now acts as a **Creem native license relay**:

- desktop app -> your relay -> Creem License API
- your merchant `CREEM_API_KEY` stays on the server
- the desktop app never sees your Creem secret API key

Legacy `AK-...` issue/revoke/reset tooling is still present for migration and support, but the desktop activation truth source is now Creem.

## Single-device policy (enforced)

- Every newly issued key is forced to `maxActivations = 1`.
- Passing `--max` in admin CLI is ignored.
- To move a customer to a new machine, reset activation first (see below).

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

## 2. Creem relay configuration

Required server env:

```bash
CREEM_API_BASE_URL=https://api.creem.io
CREEM_API_KEY=creem_live_xxx
CREEM_WEBHOOK_SECRET=whsec_xxx
LICENSE_DEFAULT_PRODUCT_ID=chordvox-pro
LICENSE_DEFAULT_OFFLINE_GRACE_HOURS=168
```

Desktop app env:

```bash
LICENSE_API_BASE_URL=https://api.your-domain.com
LICENSE_PRODUCT_ID=chordvox-pro
LICENSE_OFFLINE_GRACE_HOURS=168
```

Then customers can activate from `Settings -> Account -> Desktop License` using the **Creem-generated license key** they received after purchase.

## 3. Legacy AK tooling (optional)

Issue one license:

```bash
cd services/license-server
npm run admin -- issue --email buyer@example.com --order ord_123
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

Reset activation (device transfer):

```bash
# Reset all bound machines for this key
npm run admin -- reset-activation --key AK-7M3Q-A9K2-H8TR-W4NP

# Or reset only one machine binding
npm run admin -- reset-activation --key AK-7M3Q-A9K2-H8TR-W4NP --machine <machine_id>
```

## 4. API examples

Activate:

```bash
curl -X POST http://127.0.0.1:8787/v1/licenses/activate \
  -H "Content-Type: application/json" \
  -d '{
    "licenseKey":"lic_xxxxxxx",
    "productId":"chordvox-pro",
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
    "licenseKey":"lic_xxxxxxx",
    "productId":"chordvox-pro",
    "instanceId":"ins_xxxxxxx",
    "machineId":"abc123-machine-fingerprint",
    "appVersion":"1.5.11",
    "platform":"darwin",
    "arch":"arm64"
  }'
```

## 5. Production checklist

- Use HTTPS.
- Keep `CREEM_API_KEY` server-side only. Never ship it inside the desktop app.
- Restrict server access with firewall/rate limiting.
- Keep `services/license-server/.env` out of git.
- Back up `data/licenses.db`.
- If you keep legacy AK tooling enabled, set a strong `LICENSE_KEY_PEPPER`.
