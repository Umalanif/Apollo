/**
 * Leads Scraper — extracts person/lead data from Apollo people search page
 *
 * Phase 8: onPageReady callback fires inside the crawler requestHandler
 * when the page is fully loaded and the React app has hydrated.
 * Uses page.evaluate() to read people data from the rendered DOM.
 *
 * Usage:
 *   const onPageReady = async (page, url) => { const leads = await scrapeLeadsFromPage(page, jobId); ... }
 */

import type { Page } from 'playwright';
import { logger } from './logger';

// ── Raw lead shape extracted from the page ─────────────────────────────────────

export interface RawLead {
  linkedInUrl: string | null;
  firstName: string;
  lastName: string;
  title: string | null;
  company: string | null;
  companyUrl: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
}

// ── API Response Parser ───────────────────────────────────────────────────────

/**
 * Parse Apollo API response (from mixed_search or similar endpoint) into RawLead format.
 * Handles common Apollo response structures for people data.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseApiResponseLeads(apiData: any): Omit<RawLead, 'email' | 'phone'>[] {
  const leads: Omit<RawLead, 'email' | 'phone'>[] = [];

  // Apollo mixed_search typically returns { people: [...] } or { results: [...] } or { data: [...] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peopleArray: any[] = apiData?.people ?? apiData?.results ?? apiData?.data ?? apiData?.organizations ?? [];

  for (const person of peopleArray) {
    if (!person) continue;

    // Extract name - Apollo may store it as name, full_name, or split into first_name/last_name
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nameData = person.name ?? person.full_name ?? person.display_name ?? '';
    const nameParts = (typeof nameData === 'string' ? nameData : '').split(/\s+/).filter(Boolean);

    // LinkedIn URL - check multiple possible field names
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkedinUrl = person.linkedin_url ?? person.linkedinUrl ?? person.linkedin ?? null;
    const linkedinMatch = typeof linkedinUrl === 'string'
      ? linkedinUrl.match(/https:\/\/www\.linkedin\.com\/in\/[\w-]+/)
      : null;

    // Title - check multiple possible fields
    const title = person.title ?? person.headline ?? person.current_title ?? null;

    // Company - may be nested object or string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const companyData = person.company ?? person.organization ?? person.current_company ?? {};
    const companyName = typeof companyData === 'string'
      ? companyData
      : companyData?.name ?? companyData?.company_name ?? null;

    // Company URL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const companyUrlData = person.company_url ?? person.companyUrl ?? companyData?.linkedin_url ?? null;
    const companyUrl = typeof companyUrlData === 'string' && !companyUrlData.includes('linkedin.com')
      ? companyUrlData
      : null;

    // Location
    const location = person.location ?? person.geo ?? person.current_location ?? null;

    leads.push({
      linkedInUrl: linkedinMatch?.[0] ?? null,
      firstName: nameParts[0] ?? 'Unknown',
      lastName: nameParts.slice(1).join(' ') ?? '',
      title: typeof title === 'string' ? title : null,
      company: typeof companyName === 'string' ? companyName : null,
      companyUrl,
      location: typeof location === 'string' ? location : null,
    });
  }

  return leads;
}

// ── Main extraction function ───────────────────────────────────────────────────

/**
 * Wait for the Apollo people list to render, then extract all person records
 * via DOM traversal inside the browser context.
 *
 * Apollo renders people cards dynamically via React. We wait for a stable
 * list container, then walk the DOM tree to extract name/title/company/etc.
 *
 * @param page   - Playwright page after navigation to Apollo people search
 * @param jobId  - Job ID for logging context
 * @returns      - Array of raw lead objects (before Zod validation)
 */
export async function scrapeLeadsFromPage(page: Page, jobId: string): Promise<RawLead[]> {
  logger.info({ jobId }, 'Waiting for Apollo people list to render');

  // ── Wait for people list to appear ────────────────────────────────────────
  try {
    await page.waitForSelector(
      '.person-card, .contacts-list, [data-qa="people-list"], .list-container, .search-results, ul li',
      { timeout: 15_000 },
    );
  } catch {
    logger.warn({ jobId }, 'People list selector timeout — reloading page once');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5_000); // wait for React to re-hydrate

    try {
      await page.waitForSelector(
        '.person-card, .contacts-list, [data-qa="people-list"], .list-container, .search-results, ul li',
        { timeout: 15_000 },
      );
    } catch {
      logger.warn({ jobId }, 'People list still not found after reload — attempting extraction anyway');
    }

    // ── Debug: save screenshot on timeout for post-mortem analysis ─────────────
    try {
      const fs = await import('fs');
      const path = await import('path');
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const screenshotPath = path.join(logsDir, 'debug-last-error.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info({ jobId, screenshotPath }, 'Debug screenshot saved on selector timeout');
    } catch (screenshotErr) {
      logger.warn({ jobId, err: String(screenshotErr) }, 'Failed to save debug screenshot');
    }

    // ── Log page state for diagnostics ──────────────────────────────────────────
    try {
      const [pageTitle, pageUrl] = await Promise.all([page.title(), page.url()]);
      logger.warn({ jobId, pageTitle, pageUrl }, 'Page state at selector timeout');
    } catch (diagErr) {
      logger.warn({ jobId, err: String(diagErr) }, 'Failed to log page state');
    }
  }

  // Additional wait for React to hydrate dynamic content
  await page.waitForTimeout(2_000);

  // ── Extract people data via page.evaluate ────────────────────────────────
  logger.info({ jobId }, 'Extracting people data from page DOM');

  const rawLeads = await page.evaluate((): Omit<RawLead, 'email' | 'phone'>[] => {
    const leads: Omit<RawLead, 'email' | 'phone'>[] = [];

    // Apollo table row selectors (visible in debug screenshot)
    // Container: [class*="zp_table-row"], Name: .textLink, Title: [class*="fontSize3"]
    const cardSelectors = [
      '[class*="zp_table-row"]',
      '[class*="zpTableRow"]',
      '[data-qa*="person"]',
      '.contacts-list__item',
      // Apollo renders people in a ul/li structure
      'ul li[class*="row"]',
      'ul li[class*="card"]',
    ];

    // Find the first present card container
    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    // Fallback 1: scan all anchor tags with LinkedIn URLs and walk up to card ancestors
    if (cards.length === 0) {
      const linkedInAnchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="linkedin.com/in/"]',
      ));

      for (const anchor of linkedInAnchors) {
        const card = anchor.closest('div');
        if (!card) continue;

        const nameEl = card.querySelector('strong, .name, .profile-name, .textLink');
        const titleEl = card.querySelector('.title, .subtitle, .headline, [class*="fontSize3"]');
        const companyEl = card.querySelector('.company, .organization');
        const locationEl = card.querySelector('.location, .geo');

        const nameText = nameEl?.textContent?.trim() ?? '';
        const nameParts = nameText.split(/\s+/).filter(Boolean);

        const linkedInMatch = anchor.href.match(/https:\/\/www\.linkedin\.com\/in\/[\w-]+/);

        leads.push({
          linkedInUrl: linkedInMatch?.[0] ?? null,
          firstName: nameParts[0] ?? 'Unknown',
          lastName: nameParts.slice(1).join(' ') ?? '',
          title: titleEl?.textContent?.trim() ?? null,
          company: companyEl?.textContent?.trim() ?? null,
          companyUrl: null,
          location: locationEl?.textContent?.trim() ?? null,
        });
      }

      // Fallback 2: use captured API response if DOM extraction found nothing
      if (leads.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capturedData = (window as any)._capturedApiData;
        if (capturedData) {
          logger.info('Using captured API data for lead extraction');
          return parseApiResponseLeads(capturedData);
        }
      }

      return leads;
    }

    // Iterate over found card elements
    for (const card of cards) {
      // LinkedIn URL
      const linkedInAnchor = card.querySelector<HTMLAnchorElement>('a[href*="linkedin.com/in/"]');
      if (!linkedInAnchor) continue;

      const linkedInMatch = linkedInAnchor.href.match(/https:\/\/www\.linkedin\.com\/in\/[\w-]+/);
      if (!linkedInMatch) continue;

      const linkedInUrl = linkedInMatch[0];

      // Name: .textLink is Apollo's name element (visible in screenshot)
      const nameEls = card.querySelectorAll<HTMLElement>(
        '.textLink, strong, .name, .profile-name, .person-name, [data-qa="person-name"]',
      );
      let firstName = 'Unknown';
      let lastName = '';
      for (const nameEl of nameEls) {
        const text = nameEl.textContent?.trim() ?? '';
        if (text && text !== 'Unknown') {
          const parts = text.split(/\s+/).filter(Boolean);
          firstName = parts[0] ?? 'Unknown';
          lastName = parts.slice(1).join(' ');
          break;
        }
      }

      // Title: Apollo uses fontSize3 class and other patterns visible in screenshot
      const titleEls = card.querySelectorAll<HTMLElement>(
        '[class*="fontSize3"], .title, .subtitle, .headline, .profile-title, .person-title, [data-qa="person-title"]',
      );
      let title: string | null = null;
      for (const t of titleEls) {
        const text = t.textContent?.trim() ?? '';
        if (text) { title = text; break; }
      }

      // Company: Apollo renders company name in table cell, often with .organization class
      const companyEls = card.querySelectorAll<HTMLElement>(
        '.organization, .company, .company-name, .profile-company, [data-qa="company-name"]',
      );
      let company: string | null = null;
      for (const c of companyEls) {
        const text = c.textContent?.trim() ?? '';
        if (text) { company = text; break; }
      }

      // Company URL
      let companyUrl: string | null = null;
      const companyLinkEl = card.querySelector<HTMLAnchorElement>('.company-name a, a[href*="company"]');
      if (companyLinkEl?.href && !companyLinkEl.href.includes('linkedin.com')) {
        companyUrl = companyLinkEl.href;
      }

      // Location
      const locationEls = card.querySelectorAll<HTMLElement>(
        '.location, .geo, .address, .person-location, [data-qa="location"]',
      );
      let location: string | null = null;
      for (const l of locationEls) {
        const text = l.textContent?.trim() ?? '';
        if (text) { location = text; break; }
      }

      leads.push({
        linkedInUrl,
        firstName,
        lastName,
        title,
        company,
        companyUrl,
        location,
      });
    }

    return leads;
  });

  logger.info({ jobId, count: rawLeads.length }, `Extracted ${rawLeads.length} people from page`);

  // email/phone are null here — extracted via Apollo API in a separate pass (Phase 8+)
  return rawLeads.map(l => ({ ...l, email: null, phone: null }));
}
