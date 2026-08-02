# Deploying the GapVision backend (Railway)

The backend is two always-on services. Vercel cannot host them (no persistent
websockets); Railway or Render can. Dockerfiles are included in each package.

## One-time setup

1. Create a Railway account (railway.app — GitHub or email login, free trial,
   then ~$5/mo hobby plan).
2. Create a token: Railway dashboard → Account Settings → Tokens.

## Deploy (from repo root, or hand the token to Claude to run headlessly)

```bash
npm i -g @railway/cli
export RAILWAY_TOKEN=...        # from step 2

# Project + two services
railway init --name gapvision
railway up --service ai-service   --path-as-root packages/ai-service
railway up --service realtime     --path-as-root packages/server
```

## Environment variables (Railway dashboard → each service → Variables)

**ai-service**
| Var | Value |
|---|---|
| `GAPVISION_CRM` | `shopify` |
| `SHOPIFY_STORE_DOMAIN` | `<store>.myshopify.com` |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | from the Dev Dashboard app (read-only scopes; adapter auto-mints 24h tokens) |
| `GAPVISION_LLM` | `mock` (or `anthropic` + `ANTHROPIC_API_KEY` when ready) |

**realtime**
| Var | Value |
|---|---|
| `AI_SERVICE_URL` | the ai-service's Railway URL (e.g. `https://ai-service-production-xxxx.up.railway.app`) |

Then in Railway: Settings → Networking → Generate Domain for both services.

## Point the clients at production

- Web dashboard / simulator: build with `VITE_SERVER_URL=<realtime URL>` and
  `VITE_AI_URL=<ai-service URL>` — deployable to Vercel (static, that's fine).
- Glasses plugin: same two variables at build time; then QR-sideload.

## Sanity check

```bash
curl https://<ai-service-url>/health
# {"status":"ok","llm_provider":"mock","crm_provider":"shopify"}
curl https://<realtime-url>/health
```
