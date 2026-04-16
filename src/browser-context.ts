export interface ChallengeChecksResult {
  results: string[];
  sitekey: string | null;
}

export interface TurnstileWidgetState {
  sitekey: string | null;
  action: string | null;
  cData: string | null;
  chlPageData: string | null;
}

export interface ManualChallengeState {
  hasTurnstile: boolean;
  hasCloudflare: boolean;
  currentUrl: string;
}

export interface AutomationSignals {
  navigatorWebdriver: boolean | null;
  automationGlobals: string[];
  controlledByAutomationBanner: boolean;
  userAgent: string;
  language: string | null;
  languages: string[];
  timezone: string | null;
}

export interface ApolloSessionForensics {
  url: string;
  title: string;
  readyState: string;
  documentLanguage: string | null;
  htmlLanguage: string | null;
  bodyTextSnippet: string;
  hasCsrfCookie: boolean;
  csrfCookieToken: string;
  documentCookieSnippet: string;
  rootSelectorsPresent: string[];
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  apolloWindowKeys: string[];
}

const buildFunction = <T extends Function>(args: string[], body: string): T =>
  new Function(...args, body) as unknown as T;

export const installTurnstileObserverScript = buildFunction<() => void>([], `
  if (window.__apolloTurnstileObserverInstalled) {
    return;
  }

  window.__apolloTurnstileObserverInstalled = true;
  window.__apolloTurnstileState = window.__apolloTurnstileState || { widgets: [] };

  function inferSitekey(container, params) {
    if (params && params.sitekey) {
      return params.sitekey;
    }

    if (!container) {
      return null;
    }

    if (typeof container === 'string') {
      var selected = document.querySelector(container);
      return selected ? selected.getAttribute('data-sitekey') : null;
    }

    if (container.getAttribute) {
      return container.getAttribute('data-sitekey');
    }

    return null;
  }

  function persistWidget(container, params, widgetId) {
    var widgets = window.__apolloTurnstileState.widgets;
    var nextWidget = {
      widgetId: widgetId == null ? null : String(widgetId),
      sitekey: inferSitekey(container, params || {}),
      action: params && params.action ? String(params.action) : null,
      cData: params && (params.cData || params.data) ? String(params.cData || params.data) : null,
      chlPageData: params && (params.chlPageData || params.pageData || params.pagedata)
        ? String(params.chlPageData || params.pageData || params.pagedata)
        : null,
      callback: params && typeof params.callback === 'function' ? params.callback : null,
    };

    var replaced = false;
    for (var i = 0; i < widgets.length; i += 1) {
      if (widgets[i].widgetId && nextWidget.widgetId && widgets[i].widgetId === nextWidget.widgetId) {
        widgets[i] = nextWidget;
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      widgets.push(nextWidget);
    }

    window.__apolloTurnstileState.lastWidget = nextWidget;
  }

  function patchTurnstile(turnstile) {
    if (!turnstile || turnstile.__apolloObserverPatched || typeof turnstile.render !== 'function') {
      return;
    }

    var originalRender = turnstile.render;
    turnstile.render = function(container, params) {
      var widgetId = originalRender.apply(this, arguments);
      try {
        persistWidget(container, params || {}, widgetId);
      } catch (_err) {
        // Ignore observer failures and let the widget continue rendering.
      }
      return widgetId;
    };

    turnstile.__apolloObserverPatched = true;
  }

  var startedAt = Date.now();
  var intervalId = window.setInterval(function() {
    if (window.turnstile) {
      patchTurnstile(window.turnstile);
    }

    if (Date.now() - startedAt > 30000) {
      window.clearInterval(intervalId);
    }
  }, 50);
`);

export const detectChallengeChecksScript = buildFunction<() => ChallengeChecksResult>([], `
  var results = [];
  var sitekey = null;

  var doc = document;
  var bodyText = (doc.body && doc.body.textContent ? doc.body.textContent : '').toLowerCase();
  var title = (doc.title || '').toLowerCase();

  var cfTurnstile = doc.querySelector('.cf-turnstile, [class*="turnstile"][data-sitekey], iframe[src*="challenges.cloudflare.com"]');
  var turnstileScriptLoaded = Array.from(doc.scripts).some(function (script) {
    return script.src.includes('turnstile/v0/api.js');
  });
  var turnstileText = bodyText.includes('turnstile') || bodyText.includes('verify you are a human');
  if (cfTurnstile || (turnstileScriptLoaded && turnstileText)) {
    sitekey =
      (cfTurnstile && cfTurnstile.dataset ? cfTurnstile.dataset.sitekey : null) ||
      (cfTurnstile ? cfTurnstile.getAttribute('data-sitekey') : null) ||
      sitekey;
    results.push('turnstile');
  }

  var cfSpinner = doc.querySelector('#cf-spinner, .cf-spinner, #spinner');
  var cfBrowserVerif = doc.querySelector('#cf-browser-verification, .cf-browser-verification');
  var cfPendingCheck = doc.querySelector('#pending-check, .pending-check, #captcha-interstitial');
  var cfChallengeModal = doc.querySelector('#challeng-modal, #challenge-modal');
  var cfError = bodyText.includes('cloudflare');
  var uaChallenge = bodyText.includes('please check your browser');
  var cfVerifyHuman = bodyText.includes('verify you are a human');
  var cfAccessDenied = bodyText.includes('access denied');
  var cfAccessDeniedTitle = title.includes('access denied');

  if (cfSpinner || cfBrowserVerif || cfPendingCheck || cfChallengeModal || cfError || uaChallenge || cfVerifyHuman || cfAccessDenied) {
    results.push('cloudflare');
  }
  if (title.includes('cloudflare') || cfAccessDeniedTitle) {
    results.push('cloudflare');
  }

  var dataDomeCaptcha = doc.querySelector('[data-dome-captcha], .datadome-captcha, #datadome-captcha, .dd-captcha');
  var dataDomeModal = doc.querySelector('[data-dome-modal], .datadome-modal, #datadome-modal, .datadome-challenge-modal');
  var dataDomeCaptchaContainer = doc.querySelector('#captcha-container, .captcha-container, #hcaptcha-container');
  var dataDomeText = bodyText.includes('datadome') || bodyText.includes('data domain');
  if (dataDomeCaptcha || dataDomeModal || dataDomeCaptchaContainer || dataDomeText) {
    results.push('datadome');
  }

  var recaptchaEl = doc.querySelector('.g-recaptcha, #g-recaptcha, .grecaptcha-badge');
  var recaptchaBadge = doc.querySelector('.grecaptcha-badge, #grecaptcha-badge, .recaptcha-badge');
  var recaptchaText = bodyText.includes('recaptcha') && bodyText.includes('challenge');
  if (recaptchaEl) {
    sitekey =
      (recaptchaEl.dataset ? recaptchaEl.dataset.sitekey : null) ||
      recaptchaEl.getAttribute('data-sitekey') ||
      sitekey;
  }
  if (!sitekey) {
    var sitekeyEl = doc.querySelector('[data-sitekey]');
    sitekey = sitekeyEl ? sitekeyEl.getAttribute('data-sitekey') : null;
  }
  if (!sitekey && window.__apolloTurnstileState && window.__apolloTurnstileState.lastWidget) {
    sitekey = window.__apolloTurnstileState.lastWidget.sitekey || null;
  }
  if (recaptchaEl || recaptchaBadge || recaptchaText) {
    results.push('recaptcha');
  }

  var blockTextPatterns = [
    'access denied',
    'forbidden',
    'ip blocked',
    'blocked your ip',
    'your ip has been blocked',
    'rate limit',
    'too many requests',
    'please wait',
    'unusual traffic',
    'suspicious activity'
  ];

  for (var i = 0; i < blockTextPatterns.length; i += 1) {
    if (bodyText.includes(blockTextPatterns[i])) {
      results.push('generic_block');
      break;
    }
  }

  if (title.includes('access denied') || title.includes('forbidden') || title.includes('blocked')) {
    results.push('generic_block');
  }

  return { results: results, sitekey: sitekey };
`);

export const readManualChallengeStateScript = buildFunction<() => ManualChallengeState>([], `
  var doc = document;
  var bodyText = (doc.body && doc.body.textContent ? doc.body.textContent : '').toLowerCase();
  var title = (doc.title || '').toLowerCase();

  var hasTurnstile = Boolean(
    doc.querySelector('.cf-turnstile, [class*="turnstile"][data-sitekey], iframe[src*="challenges.cloudflare.com"]')
  ) || (
    Array.from(doc.scripts).some(function (script) {
      return script.src.includes('turnstile/v0/api.js');
    }) && (bodyText.includes('turnstile') || bodyText.includes('verify you are a human'))
  );

  var hasCloudflare = [
    bodyText.includes('cloudflare'),
    bodyText.includes('verify you are a human'),
    bodyText.includes('checking your browser'),
    bodyText.includes('access denied'),
    title.includes('cloudflare'),
    title.includes('access denied'),
    Boolean(doc.querySelector('#cf-spinner, .cf-spinner, #cf-browser-verification, .cf-browser-verification'))
  ].some(Boolean);

  return {
    hasTurnstile: hasTurnstile,
    hasCloudflare: hasCloudflare,
    currentUrl: window.location.href
  };
`);

export const readTurnstileWidgetStateScript = buildFunction<() => TurnstileWidgetState>([], `
  var fallbackSitekeyEl = document.querySelector('[data-sitekey]');
  var state = window.__apolloTurnstileState || {};
  var widgets = Array.isArray(state.widgets) ? state.widgets : [];
  var widget = widgets.length ? widgets[widgets.length - 1] : (state.lastWidget || null);

  return {
    sitekey: widget && widget.sitekey ? widget.sitekey : (fallbackSitekeyEl ? fallbackSitekeyEl.getAttribute('data-sitekey') : null),
    action: widget && widget.action ? widget.action : null,
    cData: widget && widget.cData ? widget.cData : null,
    chlPageData: widget && widget.chlPageData ? widget.chlPageData : null,
  };
`);

export const readAutomationSignalsScript = buildFunction<() => AutomationSignals>([], `
  var automationGlobals = [];
  var candidates = [
    '__playwright__binding__',
    '__pwInitScripts',
    '__nightmare',
    '__selenium_unwrapped',
    '__webdriver_evaluate',
    '__driver_evaluate',
    '__webdriver_script_fn',
    '__webdriver_script_func',
    '__lastWatirAlert',
    '__lastWatirConfirm',
    '__lastWatirPrompt',
    '_WEBDRIVER_ELEM_CACHE'
  ];

  for (var i = 0; i < candidates.length; i += 1) {
    var key = candidates[i];
    if (Object.prototype.hasOwnProperty.call(window, key)) {
      automationGlobals.push(key);
    }
  }

  var bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
  return {
    navigatorWebdriver: typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null,
    automationGlobals: automationGlobals,
    controlledByAutomationBanner: bodyText.includes('controlled by automated test software'),
    userAgent: navigator.userAgent,
    language: navigator.language || null,
    languages: Array.isArray(navigator.languages) ? navigator.languages.slice() : [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null
  };
`);

export const installAutomationMaskScript = buildFunction<() => void>([], `
  var patchNavigatorProto = function() {
    var proto = Object.getPrototypeOf(navigator);
    if (!proto) {
      return;
    }

    try {
      Object.defineProperty(proto, 'webdriver', {
        configurable: true,
        get: function() {
          return undefined;
        }
      });
    } catch (_err) {}
  };

  patchNavigatorProto();

  try {
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: window.chrome || { runtime: {} }
    });
  } catch (_err) {}

  try {
    var originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = function(parameters) {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery.apply(this, arguments);
      };
    }
  } catch (_err) {}

  try {
    Object.defineProperty(navigator, 'pdfViewerEnabled', {
      configurable: true,
      get: function() {
        return true;
      }
    });
  } catch (_err) {}
`);

export const injectChallengeTokenScript = buildFunction<(challengeToken: string) => void>(['challengeToken'], `
  var selectors = [
    'textarea[name="g-recaptcha-response"]',
    '#g-recaptcha-response',
    'textarea[name="cf-turnstile-response"]',
    'input[name="cf-turnstile-response"]',
    'input[name="cf_challenge_response"]'
  ];

  for (var i = 0; i < selectors.length; i += 1) {
    var elements = document.querySelectorAll(selectors[i]);
    for (var j = 0; j < elements.length; j += 1) {
      var element = elements[j];
      element.value = challengeToken;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  var container = document.querySelector('form') || document.body;
  if (container && !document.querySelector('[name="cf-turnstile-response"]')) {
    var hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    hiddenInput.name = 'cf-turnstile-response';
    hiddenInput.value = challengeToken;
    container.appendChild(hiddenInput);
  }

  var state = window.__apolloTurnstileState || {};
  var widgets = Array.isArray(state.widgets) ? state.widgets : [];
  for (var k = widgets.length - 1; k >= 0; k -= 1) {
    var widget = widgets[k];
    if (widget && typeof widget.callback === 'function') {
      widget.callback(challengeToken);
      break;
    }
  }

  document.dispatchEvent(new CustomEvent('recaptcha-token-ready', {
    detail: { token: challengeToken }
  }));
  document.dispatchEvent(new CustomEvent('turnstile-token-ready', {
    detail: { token: challengeToken }
  }));
`);

export const mutateHashScript = buildFunction<(hash: string) => void>(['hash'], `
  history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', {
    oldURL: window.location.href,
    newURL: window.location.origin + '/' + hash
  }));
`);

export const readCsrfTokenScript = buildFunction<() => string>([], `
  var cookies = document.cookie ? document.cookie.split(';') : [];
  for (var i = 0; i < cookies.length; i += 1) {
    var entry = cookies[i].trim();
    if (entry.indexOf('X-CSRF-TOKEN=') === 0) {
      return entry.slice('X-CSRF-TOKEN='.length);
    }
  }

  return window.__csrfToken || '';
`);

export const readApolloSessionForensicsScript = buildFunction<() => ApolloSessionForensics>([], `
  var rootSelectors = ['#root', '#app', '[data-reactroot]', '[data-testid="application-shell"]', 'main'];
  var rootSelectorsPresent = [];
  for (var i = 0; i < rootSelectors.length; i += 1) {
    if (document.querySelector(rootSelectors[i])) {
      rootSelectorsPresent.push(rootSelectors[i]);
    }
  }

  var localStorageKeys = [];
  var sessionStorageKeys = [];

  try {
    for (var j = 0; j < window.localStorage.length; j += 1) {
      var localKey = window.localStorage.key(j);
      if (localKey) {
        localStorageKeys.push(localKey);
      }
    }
  } catch (_localStorageErr) {}

  try {
    for (var k = 0; k < window.sessionStorage.length; k += 1) {
      var sessionKey = window.sessionStorage.key(k);
      if (sessionKey) {
        sessionStorageKeys.push(sessionKey);
      }
    }
  } catch (_sessionStorageErr) {}

  var apolloWindowKeys = Object.keys(window).filter(function(key) {
    return /^(__APOLLO|__apollo|Apollo|apollo)/.test(key);
  }).slice(0, 25);

  var bodyText = document.body && document.body.innerText ? document.body.innerText : '';
  var cookies = document.cookie ? document.cookie.split(';') : [];
  var csrfCookieToken = '';
  for (var m = 0; m < cookies.length; m += 1) {
    var cookie = cookies[m].trim();
    if (cookie.indexOf('X-CSRF-TOKEN=') === 0) {
      csrfCookieToken = cookie.slice('X-CSRF-TOKEN='.length);
      break;
    }
  }

  return {
    url: window.location.href,
    title: document.title || '',
    readyState: document.readyState || '',
    documentLanguage: navigator.language || null,
    htmlLanguage: document.documentElement ? (document.documentElement.lang || null) : null,
    bodyTextSnippet: bodyText.slice(0, 1200),
    hasCsrfCookie: Boolean(csrfCookieToken),
    csrfCookieToken: csrfCookieToken,
    documentCookieSnippet: document.cookie.slice(0, 1200),
    rootSelectorsPresent: rootSelectorsPresent,
    localStorageKeys: localStorageKeys,
    sessionStorageKeys: sessionStorageKeys,
    apolloWindowKeys: apolloWindowKeys,
  };
`);
