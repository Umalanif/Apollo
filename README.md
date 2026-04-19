# Apollo Scraper

Production-oriented Apollo.io lead generation automation built with TypeScript, Playwright, Prisma, and a hardened trust-diagnostics workflow.

## Overview

This repository packages a real-world Apollo scraping pipeline rather than a demo script. The project focuses on three areas that matter in production:

- deterministic lead-search execution through a CLI worker
- browser trust diagnostics for Cloudflare, PAT, session, and locale/timezone alignment
- structured logging and artifacts for failure analysis

The default runtime path is a single-run worker job. A Fastify/Bree API is also included for orchestration scenarios, but the primary deployment target is a worker-first container.

## Features

- Type-safe targeting schema validated with `zod`
- CLI worker for reproducible lead collection jobs
- Microsoft OAuth and Apollo session handling
- Cloudflare and Turnstile challenge detection
- Prisma-backed persistence and export pipeline
- Trust-debug tooling to separate IP, session, and application-level failures
- Docker packaging with automatic worker startup
- GitHub Actions CI for build, test, and image validation

## Project Structure

```text
src/
  worker-cli.ts         CLI entrypoint for single-run jobs
  worker.ts             Main worker flow
  debug-trust.ts        Environment trust diagnostics
  server.ts             Optional Fastify/Bree orchestration API
prisma/
  schema.prisma         SQLite schema
examples/
  targeting.example.json
docker/
  entrypoint.sh         Container startup automation
```

## Prerequisites

- Node.js 20+
- npm 10+
- Microsoft Edge installed for local runs
- A working proxy
- 2Captcha API key
- Apollo / Microsoft credentials

For containerized runs, the Docker image installs Microsoft Edge and the required system libraries automatically.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values.

Required:

- `PROXY_HOST`
- `PROXY_USERNAME`
- `PROXY_PASSWORD`
- `PROXY_PORT`
- `TWO_CAPTCHA_API_KEY`
- `APOLLO_MS_EMAIL` or `APOLLO_EMAIL`
- `APOLLO_MS_PASSWORD` or `APOLLO_PASSWORD`

Important runtime configuration:

- `DATABASE_URL`
- `APOLLO_BROWSER=edge`
- `BROWSER_LOCALE`
- `BROWSER_TIMEZONE_ID`
- `APOLLO_REUSE_PROFILE`
- `APOLLO_COOKIE_SEED_PATH`
- `APOLLO_TRUST_COOLDOWN_MS`

## Targeting Format

The worker accepts targeting through inline JSON or a JSON file. Supported fields:

- `keywords`
- `titles`
- `locations`
- `companies`
- `seniorities`
- `organizationNumEmployeesRanges`
- `organizationIndustryTagIds`
- `organizationIndustryKeywords`

Example:

```json
{
  "titles": ["Engineer"],
  "locations": ["United States"],
  "organizationNumEmployeesRanges": ["51,100", "101,200"],
  "organizationIndustryKeywords": ["computer software"]
}
```

## Local Usage

Install dependencies:

```bash
npm ci
npx prisma generate
```

Run build and tests:

```bash
npm run build
npm test
```

Run trust diagnostics:

```bash
npm run debug:trust
```

Run a worker job:

```bash
npm run worker -- --targeting-file examples/targeting.example.json --max-leads 10 --job-id local-demo
```

Start the optional HTTP API:

```bash
npm run build
npm run start:server
```

## Docker Usage

Build the image:

```bash
docker build -t apollo-scraper .
```

Run a worker job with a mounted targeting file:

```bash
docker run --rm \
  --env-file .env \
  -e TARGETING_FILE=/app/runtime/targeting.json \
  -e JOB_ID=container-run \
  -e MAX_LEADS=10 \
  -v "$(pwd)/examples/targeting.example.json:/app/runtime/targeting.json:ro" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/exports:/app/exports" \
  -v "$(pwd)/storage:/app/storage" \
  apollo-scraper
```

Or use Docker Compose:

```bash
docker compose up --build
```

Container startup behavior:

1. validates required environment variables
2. prepares runtime directories
3. applies the Prisma schema with `prisma db push`
4. launches the worker automatically with the provided targeting payload

## Outputs and Diagnostics

Runtime artifacts are written to ignored directories:

- `logs/` for structured logs and diagnostic screenshots
- `exports/` for generated lead files
- `storage/` for browser profiles and SQLite data

The trust-diagnostics workflow emits artifacts such as:

- `trust-report-*.json`
- `debug-ms-flow-*.png`
- `*-challenge-before-solve*.json`
- `*-challenge-after-solve*.json`

## CI

GitHub Actions validates the repository with:

- `npm ci`
- `prisma generate`
- `npm run build`
- `npm test`
- `docker build`

The CI pipeline intentionally avoids live scraping runs because those depend on private credentials, proxy reputation, and target-side risk scoring.

## Operational Notes

This codebase is production-grade from an engineering perspective, but successful live scraping remains environment-dependent. The main external variables are:

- proxy and IP reputation
- Microsoft account/session risk signals
- Apollo-side challenge scoring
- browser trust consistency across locale, timezone, and session state

That boundary is expected for this class of system. The repository is designed to make those external failures diagnosable rather than opaque.

## Security

- Never commit `.env`, cookies, profiles, logs, or exported leads.
- Treat proxy credentials, Microsoft credentials, and 2Captcha keys as secrets.
- Review generated artifacts before sharing screenshots or reports externally.
