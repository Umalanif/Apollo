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
 * Thrown when authentication fails after all retry attempts.
 * The worker should stop and log FATAL: AUTH_FAILED.
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
