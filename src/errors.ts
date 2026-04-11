/**
 * Custom error types for the Apollo scraper.
 */

/**
 * Thrown inside onChallengeDetected when the challenge type requires
 * proxy rotation (Cloudflare, DataDome) rather than in-process solving.
 * Caught by the retry loop in worker.ts which increments proxy port.
 */
export class ChallengeBypassSignal extends Error {
  readonly challengeType: string;
  readonly url: string;

  constructor(challengeType: string, url: string) {
    super(`Challenge bypass signal: ${challengeType} on ${url}`);
    this.name = 'ChallengeBypassSignal';
    this.challengeType = challengeType;
    this.url = url;
  }
}

/**
 * Thrown when the Apollo session cookie is invalid, expired, or rejected.
 * Caught by the worker retry loop which rotates proxy and retries with fresh cookie.
 */
export class InvalidSessionCookieError extends Error {
  constructor(message = 'Session cookie invalid or expired — auth API returned 401') {
    super(message);
    this.name = 'InvalidSessionCookieError';
  }
}
