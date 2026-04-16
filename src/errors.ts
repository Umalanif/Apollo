/**
 * Custom error types for the Apollo scraper.
 */

export interface ApolloResponseMeta {
  responseUrl: string;
  status: number;
  contentType: string;
  bodyPreview: string;
  challengeSitekey?: string | null;
}

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

export class SessionTrustError extends Error {
  readonly blockers: string[];

  constructor(message: string, blockers: string[] = []) {
    super(message);
    this.name = 'SessionTrustError';
    this.blockers = blockers;
  }
}

export class EnvironmentTrustError extends Error {
  readonly outcome: string;

  constructor(message: string, outcome: string) {
    super(message);
    this.name = 'EnvironmentTrustError';
    this.outcome = outcome;
  }
}

export class ManualAuthenticationRequiredError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'ManualAuthenticationRequiredError';
    this.reason = reason;
  }
}

export class ApolloResponseError extends Error {
  readonly responseMeta: ApolloResponseMeta;
  readonly validationErrors: string[];
  readonly challengeType: string | null;

  constructor(
    message: string,
    responseMeta: ApolloResponseMeta,
    validationErrors: string[] = [],
    challengeType: string | null = null,
  ) {
    super(message);
    this.name = 'ApolloResponseError';
    this.responseMeta = responseMeta;
    this.validationErrors = validationErrors;
    this.challengeType = challengeType;
  }
}
