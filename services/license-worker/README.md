# ChordVox License Worker

Cloudflare Worker + D1 version of the ChordVox license API.

It keeps the public API compatible with the VPS Node service:

- `GET /health`
- `POST /v1/trials/ensure`
- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`
- `POST /v1/licenses/deactivate`
- `POST /v1/webhooks/creem`
- `GET/POST /v1/admin/licenses...`

## Secrets

Do not put these in `wrangler.jsonc`.

Set production secrets through `wrangler secret put <NAME>`.
Set staging secrets through `wrangler secret put <NAME> --env staging`.

- `CREEM_API_KEY`
- `CREEM_WEBHOOK_SECRET`
- `LICENSE_KEY_PEPPER`
- `LICENSE_SERVER_ADMIN_TOKEN`
- `INTERNAL_OWNER_KEY`

## Local / Pre-Deploy SOP

1. `npm install`
2. `npm run types`
3. `npm run check`
4. `npm run wrangler:check` (dry-run bundle/build checks for both production and staging; does not deploy)

For the staging D1 schema only:

5. `npm run db:schema:staging`

## Deploy Environments

Use an explicit deploy target every time:

- Staging: `npm run deploy:staging`
  - Worker: `chordvox-license-worker-staging`
  - D1: `chordvox-license-staging`
  - Route: no `api.chordvox.com` route
- Production: `npm run deploy:prod`
  - Worker: `chordvox-license-worker`
  - D1: `chordvox-license-prod`
  - Route: `api.chordvox.com`

`npm run deploy` intentionally fails so staging and production cannot be confused by a default command.

After a real deployment, probe the Worker URL:

- `GET /health`
- `POST /v1/trials/ensure` with `startIfNeeded:false`
- invalid license validate should return a structured invalid response

## Production Cutover Guard

Do not route `api.chordvox.com` here until:

- VPS SQLite data is exported and imported into the production D1 database.
- `LICENSE_KEY_PEPPER` is identical to the VPS value.
- Existing legacy AK license activation/validate works against the Worker.
- Creem activate/validate/deactivate failure mapping matches the VPS service.
- Rollback route is ready: point `api.chordvox.com` back to `45.92.159.246`.
