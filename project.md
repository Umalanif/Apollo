## SUMMARY
This execution plan outlines the development of a resilient, isolated B2B lead generation pipeline targeting Apollo.io. The system orchestrates an API-triggered job using Fastify and Bree, spawning a fully isolated Crawlee `worker_thread` equipped with DataImpulse sticky proxies, 2Captcha dynamic solving, and direct API interception (`got`), ensuring strictly validated data persists into a libSQL database via Prisma and Zod.

## EXECUTION PLAN

- [ ] **Step 1: Environment & Schema Setup**
  - **Type:** Coupled Group
  - **Requirements:** 1. Configure `dotenv` to load environment variables.
    2. Create a Zod schema to strictly validate `.env` keys (`PROXY_HOST`, `PROXY_USERNAME`, `PROXY_PASSWORD`, `TWO_CAPTCHA_API_KEY`, `APOLLO_SESSION_COOKIE`).
    3. Define the Prisma schema using the `sqlite` provider (representing libSQL in WAL mode) with the exact `Lead` model provided (enforcing `@unique` on `linkedInUrl`).
    4. Create a Zod schema for Lead validation (enforcing `.trim()`, regex for URL/Email formats, Title Case for names, and emoji stripping).
  - **Key Constraints:** The Prisma provider must be `sqlite` (libSQL compatible). Zod must validate environments before the app starts.

- [ ] **Step 2: [Smoke Test - Database & Validation Foundation]**
  - **Success Criteria:** Running `npx prisma db push` successfully generates the SQLite `.db` file, and passing mock valid/invalid payloads through the Zod Lead schema behaves as expected.
  - **Action:** If passes -> proceed to next step without refactoring.

- [ ] **Step 3: Database Access & Persistence Service**
  - **Type:** Isolated 
  - **Requirements:** Create a dedicated DB service file exposing a `saveLead` function. This function must receive raw scraped data, run it through the Zod Lead schema (`.safeParse()`), and, upon success, execute an idempotent `prisma.lead.upsert` using `linkedInUrl` (or composite key) as the unique identifier.
  - **Key Constraints:** Must enforce zero duplicates via the Prisma upsert block. Invalid Zod parses must log to Pino and discard the record, never crashing the thread.

- [ ] **Step 4: [Smoke Test - Persistence Layer]**
  - **Success Criteria:** Executing `saveLead` with dummy data creates a record in the libSQL DB. Running it again with the same `linkedInUrl` updates the record rather than duplicating it.
  - **Action:** If passes -> proceed to next step without refactoring.

- [ ] **Step 5: Worker Scaffolding & Export Utilities**
  - **Type:** Coupled Group
  - **Requirements:** 1. Create a standalone worker script configured for Bree's `worker_threads` context. Set up Pino for JSON logging within this thread.
    2. Implement an export routine using `fast-csv` and `exceljs` that queries the libSQL database for all extracted leads. 
    3. Use `filenamify` to generate safe timestamped filenames for the resulting `.csv` and `.xlsx` files upon job completion or graceful shutdown.
  - **Key Constraints:** The export must read directly from the database, not in-memory arrays, to ensure fault tolerance.

- [ ] **Step 6: Crawler Infrastructure & Proxy Routing**
  - **Type:** Coupled Group
  - **Requirements:** 1. Initialize `PlaywrightCrawler` with `puppeteer-extra-plugin-stealth`. Configure it to aggressively block images, fonts, media, and stylesheets via route interception.
    2. Build a proxy generation utility that formats the DataImpulse sticky proxy string using a mutable port variable (starting at 10000).
    3. Implement Session Hydration: Before navigation, parse the `APOLLO_SESSION_COOKIE` and inject it using `context.addCookies()`.
  - **Key Constraints:** Concurrency MUST be locked to 1. The proxy URL format must be strict: `http://USER:PASS@HOST:PORT`.

- [ ] **Step 7: Extraction, CAPTCHA & Failover Logic**
  - **Type:** Coupled Group
  - **Requirements:** 1. **Extraction/Rate Limiting:** Implement a `bottleneck` instance (3-15s delay). Once authenticated via cookies, use `got` to hit Apollo's hidden XHR/GraphQL endpoints. The `got` client MUST use the exact same proxy string/port as the current Playwright context.
    2. **Anti-Captcha:** Implement a DOM scanner. If a challenge is detected (Cloudflare/DataDome/reCAPTCHA), extract the sitekey, pass it to `2captcha-ts`, await the token, and inject the callback natively.
    3. **Failover/Retry Loop:** Wrap requests in a `try/catch`. If a 401/403, proxy timeout (`ERR_PROXY_CONNECTION_FAILED`), or CAPTCHA failure (x3) occurs: log WARN via Pino, destroy Playwright context and `got` instance, increment the proxy port variable (e.g., +1), re-hydrate the session, and restart the loop.
  - **Key Constraints:** Do NOT automate UI logins. Fall back to direct `got` API requests as soon as session viability is confirmed.

- [ ] **Step 8: [Smoke Test - The Extraction Worker]**
  - **Success Criteria:** Running the worker script directly (mocking Bree's payload) launches Playwright, hydrates the session, intercepts an API call via `got`, processes 1-2 pages of leads, saves them to libSQL via the save service, and outputs a sanitized CSV.
  - **Action:** If passes -> proceed to next step without refactoring.

- [ ] **Step 9: API Routing & Orchestration Setup**
  - **Type:** Coupled Group
  - **Requirements:** 1. Initialize a Fastify server.
    2. Integrate `fastify-type-provider-zod` to provide strict type safety on API endpoints.
    3. Create a POST endpoint `/api/jobs/apollo` that accepts targeting filters (Job Titles, Location, Industry, Size). Define a Zod schema for this payload.
    4. Initialize Bree to point to the worker script created in Step 5.
  - **Key Constraints:** Fastify must strictly reject invalid payloads before they ever reach Bree.

- [ ] **Step 10: Event Loop Isolation Integration**
  - **Type:** Coupled Group
  - **Requirements:** Inside the `/api/jobs/apollo` endpoint controller, upon successful payload validation, format the configuration object and trigger `bree.run('worker-name', { workerData: validatedPayload })`. Return a `202 Accepted` response immediately.
  - **Key Constraints:** The Fastify Event Loop must not block. Heavy Playwright rendering and `got` polling must remain isolated inside the Bree `worker_thread`.

- [ ] **Step 11: [Smoke Test - End-to-End Orchestration]**
  - **Success Criteria:** Sending a valid POST payload to the Fastify server returns a 202. The Bree worker thread spawns successfully, accepts the `workerData`, runs the proxy-routed extraction, and persists data to SQLite, all without stalling the Fastify server's ability to answer new requests.
  - **Action:** If passes -> task complete. Proceed to deployment prep.