# BLOCKED-VERCEL — persistent Vercel deploy needs a token

Status: **the game is deployed and serving, but only as a temporary anonymous
deployment.** A *persistent* (project-owned, auto-deploying) Vercel deployment was not
possible headlessly because the Vercel CLI is not authenticated in this environment and
no `VERCEL_TOKEN` is available.

What was tried (Vercel CLI 59.23.2, installed via `npm i -g vercel`):

- `vercel whoami` → `{"loggedIn": false, "status": "action_required"}`
- `vercel deploy --prod --yes` → `Error: No existing credentials found ... run 'vercel login'`

## Live right now (temporary, expires ~60 minutes)

- URL: https://temporary-turbo-perseus-1w66ooi.vercel.app  (verified: HTTP 200, serves the game)
- Claim it to keep it (log in with any Vercel account):
  https://vercel.com/claim-deployment?code=c8739d46-d1d7-438c-884c-25a24de2c9d7

## How to make the deploy permanent

**(a) Non-interactive, with a token** (preferred for CI / future autonomous runs):

```bash
npm i -g vercel
vercel --prod --token <TOKEN>
```

`<TOKEN>` is a Vercel access token created at https://vercel.com/account/tokens
(scope: full account). This links the project and production-deploys this directory.

**(b) Zero-config fallback for a human** (recommended, one click):

1. Open https://vercel.com/new
2. Import the `zeke-cmd/bell-loop` repo (already pushed to GitHub: https://github.com/zeke-cmd/bell-loop)
3. Vite is auto-detected — **zero config**, just click Deploy.
4. Every future `git push` to `main` auto-deploys to production.

No changes to the repo are needed for either path: the build command is `npm run build`,
output `dist/`, both auto-detected from `package.json`.
