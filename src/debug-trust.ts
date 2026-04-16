import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APOLLO_LOGIN_URL, configureApolloPage } from './apollo-browser';
import { getApolloBrowserConfig } from './browser-config';
import { attachPageDiagnostics } from './browser-diagnostics';
import { detectChallenge } from './challenge-detector';
import { launchApolloContext } from './browser-launch';
import { getEnv } from './env/schema';
import { runApolloSessionPreflight } from './session-preflight';
import { AuthManager } from './services/auth.service';

const CREEPJS_URL = 'https://abrahamjuliot.github.io/creepjs/';
const DEFAULT_CF_PROBE_URL = 'https://www.cloudflare.com/';

interface TrustProbeResult {
  url: string;
  title: string;
  challengeType: string | null;
  screenshotPath: string | null;
}

interface WebRtcSnapshot {
  candidates: string[];
  publicCandidates: string[];
  privateCandidates: string[];
}

async function saveScreenshot(page: Parameters<typeof detectChallenge>[0], name: string): Promise<string | null> {
  try {
    const logsDir = path.resolve('logs');
    await mkdir(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `trust-${name}-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

async function probePage(page: Parameters<typeof detectChallenge>[0], url: string, name: string): Promise<TrustProbeResult> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await page.waitForTimeout(3_000);
  const challenge = await detectChallenge(page);
  const screenshotPath = await saveScreenshot(page, name);
  const title = await page.title();

  return {
    url: page.url(),
    title,
    challengeType: challenge.type,
    screenshotPath,
  };
}

async function readBrowserIp(page: Parameters<typeof detectChallenge>[0]): Promise<string | null> {
  return page.evaluate(async () => {
    try {
      const response = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      const body = await response.json() as { ip?: string };
      return body.ip ?? null;
    } catch {
      return null;
    }
  });
}

async function readWebRtcSnapshot(page: Parameters<typeof detectChallenge>[0]): Promise<WebRtcSnapshot> {
  return page.evaluate(async () => {
    const candidates = new Set<string>();

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.createDataChannel('apollo-trust');
    pc.onicecandidate = event => {
      if (!event.candidate?.candidate) {
        return;
      }

      const ips = event.candidate.candidate.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
      for (const ip of ips) {
        candidates.add(ip);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(resolve => setTimeout(resolve, 4_000));
    pc.close();

    const allCandidates = [...candidates];
    const privateCandidates = allCandidates.filter(ip =>
      ip.startsWith('10.')
      || ip.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip),
    );
    const publicCandidates = allCandidates.filter(ip => !privateCandidates.includes(ip));

    return {
      candidates: allCandidates,
      publicCandidates,
      privateCandidates,
    };
  });
}

async function main(): Promise<void> {
  const env = getEnv();
  const browserConfig = getApolloBrowserConfig();
  const context = await launchApolloContext(`trust-${Date.now()}`);

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await configureApolloPage(page);
    attachPageDiagnostics(page, 'trust');

    const browserSignals = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    const browserIp = await readBrowserIp(page);
    const webRtc = await readWebRtcSnapshot(page);

    const creepjs = await probePage(page, CREEPJS_URL, 'creepjs');
    const cloudflareProbe = await probePage(page, env.CLOUDFLARE_PROBE_URL ?? DEFAULT_CF_PROBE_URL, 'cloudflare-probe');

    await page.goto(APOLLO_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await AuthManager.ensureAuthenticated(page, 'trust');
    const sessionPreflight = await runApolloSessionPreflight(page);
    const apolloWarmupScreenshot = await saveScreenshot(page, 'apollo-warmup');

    const report = {
      recordedAt: new Date().toISOString(),
      browser: {
        name: browserConfig.name,
        label: browserConfig.launchLabel,
        locale: browserConfig.locale,
        timezoneId: browserConfig.timezoneId ?? null,
      },
      proxy: {
        host: env.PROXY_HOST,
        port: env.PROXY_PORT,
      },
      browserSignals,
      browserIp,
      webrtc: webRtc,
      webrtcPublicIpAlignment: browserIp
        ? (webRtc.publicCandidates.includes(browserIp) ? 'aligned' : (webRtc.publicCandidates.length ? 'mismatch' : 'unknown'))
        : 'unknown',
      timezoneLanguageConsistency: {
        browserLanguage: browserSignals.language,
        browserLanguages: browserSignals.languages,
        browserTimezone: browserSignals.timezone,
        configuredLocale: browserConfig.locale,
        configuredTimezoneId: browserConfig.timezoneId ?? null,
        timezoneMatchesConfigured: browserConfig.timezoneId ? browserSignals.timezone === browserConfig.timezoneId : null,
      },
      probes: {
        creepjs,
        cloudflareProbe,
        apolloWarmup: {
          url: page.url(),
          screenshotPath: apolloWarmupScreenshot,
          manualSolveSucceeded: !sessionPreflight.blockers.length,
        },
      },
      cloudflareChallengeAppeared: Boolean(cloudflareProbe.challengeType),
      manualSolveSucceeded: !sessionPreflight.blockers.length,
      lowTrust: (
        (browserIp && webRtc.publicCandidates.length > 0 && !webRtc.publicCandidates.includes(browserIp))
        || Boolean(sessionPreflight.blockers.length)
      ),
      sessionPreflight,
    };

    const logsDir = path.resolve('logs');
    await mkdir(logsDir, { recursive: true });
    const reportPath = path.join(logsDir, `trust-report-${Date.now()}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`browser=${browserConfig.name}`);
    console.log(`cloudflare_probe_url=${cloudflareProbe.url}`);
    console.log(`cloudflare_challenge=${cloudflareProbe.challengeType ?? 'none'}`);
    console.log(`apollo_session_blockers=${sessionPreflight.blockers.length}`);
    console.log(`trust_report=${reportPath}`);
  } finally {
    await context.close();
  }
}

void main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
