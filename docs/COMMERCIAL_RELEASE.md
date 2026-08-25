# Commercial Licensing Checklist (Internal Only)

> [!WARNING]
> Internal use only.  
> Do not publish this document to customers, public website pages, release notes, or marketing materials.
>
> 仅供内部使用。  
> 本文档不得对外公开，不作为客户运营说明或公开售卖说明。

## 1) Release rules live in one place

This document owns commercial licensing only. Public release channels, signing/notarization, real-dictation preflight, fallback environments, customer first-launch guidance, release notes, and the failure ledger are maintained exclusively in [`RELEASE_SOP.md`](RELEASE_SOP.md).

Do not copy release rules back into this file. When the workflow or fallback policy changes, update the canonical SOP and the workflow itself so the two sources remain verifiable.

## 2) Desktop license validation skeleton

Main-process license manager:

- File: `src/helpers/licenseManager.js`
- IPC:
  - `license-get-status`
  - `license-activate`
  - `license-validate`
  - `license-clear`
- UI:
  - Account section in settings contains a "Desktop License" panel

### Environment variables (desktop app)

```bash
LICENSE_API_BASE_URL=
LICENSE_PRODUCT_ID=chordvox-pro
LICENSE_API_TOKEN=
LICENSE_API_TIMEOUT_MS=8000
LICENSE_OFFLINE_GRACE_HOURS=168
LICENSE_ALLOW_DEV_KEYS=false
```

### Expected API contract (server side)

- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`

Request body:

```json
{
  "licenseKey": "XXXX-XXXX-XXXX",
  "productId": "chordvox-pro",
  "machineId": "stable-machine-fingerprint",
  "appVersion": "1.5.0",
  "platform": "darwin",
  "arch": "arm64"
}
```

Typical success response:

```json
{
  "valid": true,
  "status": "active",
  "plan": "pro",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "offlineGraceHours": 168,
  "message": "License valid"
}
```

When no license API is configured, only keys prefixed with `DEV-` are accepted **and only when** `LICENSE_ALLOW_DEV_KEYS=true` (or `NODE_ENV=development`).

### New: ready-to-run license backend

This repository now includes `services/license-server`:

- API: `POST /v1/licenses/activate`, `POST /v1/licenses/validate`
- Storage: SQLite
- Admin tooling: issue/revoke/list/reset-activation via CLI
- Policy: single-device enforced (`1 key = 1 device`)

See:

- `services/license-server/README.md`
- `docs/LICENSE_SALES_FLOW.md`
