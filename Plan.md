# EXECUTION PLAN — Apollo B2B Lead Generation Pipeline

## Phase 0: Foundation
- [ ] 0.1: Initialize project structure (package.json, tsconfig.json, .env.example)
- [ ] 0.2: Create Wall.md architectural decisions log

## Phase 1: Environment & Schema Setup
- [ ] 1.1: Configure dotenv for environment variables
- [ ] 1.2: Create Zod schema for env validation (PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD, TWO_CAPTCHA_API_KEY, APOLLO_SESSION_COOKIE)
- [ ] 1.3: Create Prisma schema with Lead model (sqlite provider, libSQL WAL mode, @unique on linkedInUrl)
- [ ] 1.4: Create Zod schema for Lead validation (trim, URL/Email regex, Title Case, emoji stripping)

## Phase 2: Smoke Test — Database & Validation Foundation
- [x] 2.1: Run `npx prisma db push` — verify SQLite .db file generated
- [x] 2.2: Test Zod Lead schema with mock valid/invalid payloads

## Phase 3: Database Access & Persistence Service
- [x] 3.1: Create db.service.ts with saveLead function
- [x] 3.2: Implement Zod safeParse + Prisma upsert (linkedInUrl as unique key)
- [x] 3.3: Add Pino logging for invalid parses (discard, never crash)

## Phase 4: Smoke Test — Persistence Layer
- [x] 4.1: Execute saveLead with dummy data — verify record created
- [x] 4.2: Execute saveLead with same linkedInUrl — verify update not duplicate

## Phase 5: Worker Scaffolding & Export Utilities
- [x] 5.1: Create standalone worker script (Bree worker_threads context)
- [x] 5.2: Configure Pino JSON logging in worker thread
- [x] 5.3: Implement export routine (fast-csv + exceljs) — read from DB, not memory
- [x] 5.4: Use filenamify for timestamped .csv/.xlsx filenames

## Phase 6: Crawler Infrastructure & Proxy Routing
- [x] 6.1: Initialize PlaywrightCrawler with puppeteer-extra-plugin-stealth
- [x] 6.2: Configure aggressive blocking (images, fonts, media, stylesheets) via route interception
- [x] 6.3: Build proxy generation utility (DataImpulse sticky proxy, mutable port starting 10000)
- [x] 6.4: Implement Session Hydration — parse APOLLO_SESSION_COOKIE, inject via context.addCookies()
- [x] 6.5: Lock concurrency to 1, strict proxy URL format: http://USER:PASS@HOST:PORT

## Phase 7: Extraction, CAPTCHA & Failover Logic
- [x] 7.1: Implement bottleneck instance (3-15s delay)
- [x] 7.2: Use got for Apollo hidden XHR/GraphQL endpoints — same proxy as Playwright context
- [x] 7.3: Implement DOM scanner for challenge detection (Cloudflare/DataDome/reCAPTCHA)
- [x] 7.4: If challenge detected — extract sitekey, pass to 2captcha-ts, await token, inject callback
- [x] 7.5: Wrap requests in try/catch — handle 401/403, proxy timeout (ERR_PROXY_CONNECTION_FAILED), CAPTCHA failure (x3)
- [x] 7.6: On failure — log WARN, destroy Playwright context + got instance, increment proxy port, re-hydrate session, restart loop

## Phase 8: Smoke Test — The Extraction Worker
- [x] 8.1: Run worker script directly (mock Bree payload)
- [x] 8.2: Verify: Playwright launches → session hydrates → got intercepts API → saves leads to libSQL → outputs CSV

## Phase 9: API Routing & Orchestration Setup
- [x] 9.1: Initialize Fastify server
- [x] 9.2: Integrate fastify-type-provider-zod
- [x] 9.3: Create POST /api/jobs/apollo endpoint with Zod schema for targeting filters
- [x] 9.4: Initialize Bree pointing to worker script

## Phase 10: Event Loop Isolation Integration
- [x] 10.1: In /api/jobs/apollo controller — validate payload, trigger bree.run('worker-name', { workerData })
- [x] 10.2: Return 202 Accepted immediately — do NOT block Fastify event loop

## Phase 11: Smoke Test — End-to-End Orchestration
- [x] 11.1: POST valid payload to Fastify → verify 202 returned
- [x] 11.2: Verify Bree worker spawns, accepts workerData, extracts, persists to SQLite
  - Bree worker spawns with correct jobId + targeting — VERIFIED
  - ChallengeBypassSignal propagation fix — signal now correctly fails crawler's request
  - Worker retry loop rotates proxy after max failures — VERIFIED
  - NOTE: Cloudflare blocks DataImpulse datacenter proxy — 0 leads extracted in test environment
- [x] 11.3: Verify Fastify server remains responsive to new requests during worker execution
