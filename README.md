# Apollo Scraper — production lead-generation automation for Apollo.io workflows.

[Features](#features) · [Tech Stack](#tech-stack) · [Quick Start](#quick-start) · [Environment Variables](#environment-variables)

│ TypeScript scraping pipeline with Playwright, Crawlee, Prisma, Docker, and trust-diagnostics tooling.

## Features

- Runs reproducible lead collection jobs through a CLI worker.
- Supports Apollo and Microsoft login flows with session reuse.
- Detects Cloudflare, Turnstile, and trust-environment failures.
- Persists leads and runtime artifacts with Prisma-backed storage.
- Exports diagnostics, screenshots, and structured logs for debugging.

## Tech Stack

```text
┌────────────┬──────────────────────────────────────────────┐
│ Layer      │ Technology                                   │
├────────────┼──────────────────────────────────────────────┤
│ Runtime    │ Node.js 20 / TypeScript                     │
├────────────┼──────────────────────────────────────────────┤
│ Scraping   │ Playwright / Crawlee                        │
├────────────┼──────────────────────────────────────────────┤
│ API        │ Fastify                                     │
├────────────┼──────────────────────────────────────────────┤
│ Scheduling │ Bree                                         │
├────────────┼──────────────────────────────────────────────┤
│ Database   │ Prisma ORM / SQLite                         │
├────────────┼──────────────────────────────────────────────┤
│ Validation │ Zod / zod-to-json-schema                    │
├────────────┼──────────────────────────────────────────────┤
│ Logging    │ Pino                                         │
├────────────┼──────────────────────────────────────────────┤
│ Infra      │ Docker / GitHub Actions                     │
└────────────┴──────────────────────────────────────────────┘
```

## Quick Start

```bash
git clone https://github.com/Umalanif/Apollo.git
cd Apollo
cp .env.example .env
npm ci
npx prisma generate
npm run build
npm run worker -- --targeting-file examples/targeting.example.json --max-leads 10 --job-id local-demo
```

## Environment Variables

```text
┌─────────────────────────┬──────────────────────────────────────────────────────┬──────────┐
│ Variable                │ Description                                          │ Required │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ DATABASE_URL            │ Prisma database path                                 │ No       │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ PROXY_HOST              │ Proxy host                                           │ Yes      │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ PROXY_USERNAME          │ Proxy username                                       │ Yes      │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ PROXY_PASSWORD          │ Proxy password                                       │ Yes      │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ PROXY_PORT              │ Proxy port                                           │ Yes      │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ TWO_CAPTCHA_API_KEY     │ 2Captcha API key                                     │ Yes      │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_EMAIL            │ Apollo account email                                 │ Cond.    │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_PASSWORD         │ Apollo account password                              │ Cond.    │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_MS_EMAIL         │ Microsoft OAuth email                                │ Cond.    │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_MS_PASSWORD      │ Microsoft OAuth password                             │ Cond.    │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_BROWSER          │ Browser channel, default `edge`                      │ No       │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ BROWSER_LOCALE          │ Browser locale                                       │ No       │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ BROWSER_TIMEZONE_ID     │ Browser timezone for trust alignment                 │ No       │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_REUSE_PROFILE    │ Reuse browser profile between runs                   │ No       │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_COOKIE_SEED_PATH │ Optional cookie seed file                            │ No       │
├─────────────────────────┼──────────────────────────────────────────────────────┼──────────┤
│ APOLLO_TRUST_COOLDOWN_MS│ Cooldown between trust retries                       │ No       │
└─────────────────────────┴──────────────────────────────────────────────────────┴──────────┘
```

`Cond.` means you need either the Apollo credentials pair or the Microsoft OAuth pair.

## Project Structure

```text
src/
  api/
  crawler/
  db/
  env/
  services/
  worker/
  debug-trust.ts
  index.ts
  server.ts
  worker-cli.ts
  worker.ts
prisma/
  schema.prisma
examples/
  targeting.example.json
docker/
  entrypoint.sh
.github/workflows/
  ci.yml
```

## License

Not specified.
