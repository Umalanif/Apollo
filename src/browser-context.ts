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

export interface SyntheticSpeechVoice {
  default: boolean;
  lang: string;
  localService: boolean;
  name: string;
  voiceURI: string;
}

export interface AutomationMaskConfig {
  locale: string;
  languages: string[];
  speechVoices: SyntheticSpeechVoice[];
}

function normalizeLocale(locale: string | undefined): string {
  const trimmed = (locale ?? '').trim();
  return trimmed || 'en-US';
}

export function buildLocaleLanguages(locale: string | undefined): string[] {
  const normalizedLocale = normalizeLocale(locale);
  const primaryLanguage = normalizedLocale.split(/[-_]/)[0]?.toLowerCase() || 'en';
  const variants = [
    normalizedLocale,
    primaryLanguage,
    ...(primaryLanguage === 'en' ? [] : ['en-US', 'en']),
  ];

  return [...new Set(variants.filter(Boolean))];
}

export function buildAcceptLanguageHeader(locale: string | undefined): string {
  return buildLocaleLanguages(locale)
    .map((language, index) => index === 0 ? language : `${language};q=${Math.max(0.1, 1 - (index * 0.1)).toFixed(1)}`)
    .join(',');
}

export function buildSyntheticSpeechVoices(locale: string | undefined): SyntheticSpeechVoice[] {
  const normalizedLocale = normalizeLocale(locale);
  const primaryLanguage = normalizedLocale.split(/[-_]/)[0]?.toLowerCase() || 'en';

  const localizedVoiceByLanguage: Record<string, { name: string; lang: string }> = {
    de: { name: 'Microsoft Katja - German (Germany)', lang: 'de-DE' },
    en: { name: 'Microsoft Aria - English (United States)', lang: 'en-US' },
    fr: { name: 'Microsoft Denise - French (France)', lang: 'fr-FR' },
    es: { name: 'Microsoft Elvira - Spanish (Spain)', lang: 'es-ES' },
    it: { name: 'Microsoft Elsa - Italian (Italy)', lang: 'it-IT' },
    nl: { name: 'Microsoft Colette - Dutch (Netherlands)', lang: 'nl-NL' },
    pl: { name: 'Microsoft Paulina - Polish (Poland)', lang: 'pl-PL' },
    pt: { name: 'Microsoft Maria - Portuguese (Brazil)', lang: 'pt-BR' },
  };

  const localizedVoice = localizedVoiceByLanguage[primaryLanguage] ?? localizedVoiceByLanguage.en;
  const fallbackVoices = [
    localizedVoice,
    { name: 'Microsoft Aria - English (United States)', lang: 'en-US' },
  ];

  return fallbackVoices.map((voice, index) => ({
    default: index === 0,
    lang: voice.lang,
    localService: true,
    name: voice.name,
    voiceURI: voice.name,
  }));
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

export const readManualChallengeStateScript = buildFunction<() => ManualChallengeState>([], `
  var doc = document;
  var currentUrl = window.location.href;
  var bodyText = (doc.body && doc.body.innerText ? doc.body.innerText : '').toLowerCase();
  var hasChallengeIframe = Boolean(
    doc.querySelector([
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="/cdn-cgi/challenge-platform/"]',
      'iframe[src*="turnstile"]',
      'iframe[title*="Cloudflare"]',
      'iframe[title*="Turnstile"]',
      'iframe[name*="cf-chl-widget"]'
    ].join(', '))
  );
  var hasTurnstileWidget = Boolean(
    doc.querySelector([
      '.cf-turnstile',
      '[data-sitekey][class*="turnstile"]',
      '[id*="cf-chl-widget"]',
      '[class*="cf-challenge"]',
      '[class*="cf-turnstile"]'
    ].join(', '))
  );
  var hasChallengeUrl = currentUrl.includes('challenges.cloudflare.com') || currentUrl.includes('/cdn-cgi/challenge-platform/');
  var hasChallengeText = (
    bodyText.includes('cloudflare')
    || bodyText.includes('turnstile')
    || bodyText.includes('verify you are human')
    || bodyText.includes('verify that you are human')
    || bodyText.includes('checking your browser')
    || bodyText.includes('checking if the site connection is secure')
    || bodyText.includes('review the security of your connection')
    || bodyText.includes('troubleshooting')
    || bodyText.includes('problembehebung')
    || bodyText.includes('verification failed')
    || bodyText.includes('uberprufung fehlgeschlagen')
  );

  var hasTurnstile = hasTurnstileWidget || hasChallengeIframe;
  var hasCloudflare = hasChallengeUrl || hasChallengeIframe || hasTurnstileWidget || hasChallengeText;

  return {
    hasTurnstile: hasTurnstile,
    hasCloudflare: hasCloudflare,
    currentUrl: currentUrl
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

export const installAutomationMaskScript = buildFunction<(config: AutomationMaskConfig) => void>(['config'], `
  var effectiveConfig = config || {};
  var languages = Array.isArray(effectiveConfig.languages) && effectiveConfig.languages.length
    ? effectiveConfig.languages.slice()
    : ['en-US', 'en'];
  var locale = languages[0] || effectiveConfig.locale || 'en-US';
  var speechVoices = Array.isArray(effectiveConfig.speechVoices) ? effectiveConfig.speechVoices.slice() : [];

  var defineGetter = function(target, property, getter) {
    if (!target) {
      return;
    }

    try {
      Object.defineProperty(target, property, {
        configurable: true,
        get: getter
      });
    } catch (_err) {}
  };

  var patchNavigatorProto = function() {
    var proto = Object.getPrototypeOf(navigator);
    if (!proto) {
      return;
    }

    defineGetter(proto, 'webdriver', function() {
      return false;
    });
    defineGetter(proto, 'language', function() {
      return locale;
    });
    defineGetter(proto, 'languages', function() {
      return languages.slice();
    });
  };

  var removeAutomationGlobals = function() {
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
      try {
        delete window[key];
      } catch (_deleteErr) {}

      try {
        Object.defineProperty(window, key, {
          configurable: true,
          get: function() {
            return undefined;
          }
        });
      } catch (_defineErr) {}
    }
  };

  var buildUserAgentData = function() {
    var ua = navigator.userAgent || '';
    var edgeMatch = ua.match(/Edg\\/([\\d.]+)/);
    var chromeMatch = ua.match(/Chrome\\/([\\d.]+)/);
    var browserVersion = (edgeMatch && edgeMatch[1]) || (chromeMatch && chromeMatch[1]) || '123.0.0.0';
    var majorVersion = browserVersion.split('.')[0] || '123';
    var brands = edgeMatch
      ? [
        { brand: 'Microsoft Edge', version: majorVersion },
        { brand: 'Chromium', version: majorVersion },
        { brand: 'Not=A?Brand', version: '24' }
      ]
      : [
        { brand: 'Chromium', version: majorVersion },
        { brand: 'Google Chrome', version: majorVersion },
        { brand: 'Not=A?Brand', version: '24' }
      ];
    var platform = /Windows/i.test(ua)
      ? 'Windows'
      : (/Macintosh/i.test(ua) ? 'macOS' : (/Linux/i.test(ua) ? 'Linux' : 'Unknown'));
    return {
      brands: brands,
      mobile: false,
      platform: platform,
      getHighEntropyValues: function(hints) {
        var values = {
          architecture: 'x86',
          bitness: '64',
          brands: brands,
          fullVersionList: brands.map(function(entry) {
            return { brand: entry.brand, version: browserVersion };
          }),
          mobile: false,
          model: '',
          platform: platform,
          platformVersion: '15.0.0',
          uaFullVersion: browserVersion,
          wow64: false
        };
        if (!Array.isArray(hints)) {
          return Promise.resolve(values);
        }

        var filtered = {};
        for (var i = 0; i < hints.length; i += 1) {
          var hint = hints[i];
          if (Object.prototype.hasOwnProperty.call(values, hint)) {
            filtered[hint] = values[hint];
          }
        }
        if (!Object.prototype.hasOwnProperty.call(filtered, 'brands')) {
          filtered.brands = brands;
        }
        if (!Object.prototype.hasOwnProperty.call(filtered, 'mobile')) {
          filtered.mobile = false;
        }
        if (!Object.prototype.hasOwnProperty.call(filtered, 'platform')) {
          filtered.platform = platform;
        }
        return Promise.resolve(filtered);
      },
      toJSON: function() {
        return {
          brands: brands,
          mobile: false,
          platform: platform
        };
      }
    };
  };

  var createNamedArray = function(entries, nameKey) {
    var list = entries.slice();
    list.item = function(index) {
      return list[index] || null;
    };
    list.namedItem = function(name) {
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i][nameKey] === name) {
          return list[i];
        }
      }
      return null;
    };
    list.refresh = function() {};
    return list;
  };

  var patchPlugins = function() {
    var plugins = navigator.plugins;
    if (plugins && typeof plugins.length === 'number' && plugins.length > 0) {
      return;
    }

    var mimeTypes = createNamedArray([
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
    ], 'type');
    var fakePlugins = createNamedArray([
      {
        name: 'PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        0: mimeTypes[0],
        1: mimeTypes[1],
        length: 2
      },
      {
        name: 'Chromium PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        0: mimeTypes[0],
        1: mimeTypes[1],
        length: 2
      }
    ], 'name');

    defineGetter(Object.getPrototypeOf(navigator), 'plugins', function() {
      return fakePlugins;
    });
    defineGetter(Object.getPrototypeOf(navigator), 'mimeTypes', function() {
      return mimeTypes;
    });
  };

  var patchSpeechSynthesis = function() {
    if (!window.speechSynthesis || !speechVoices.length) {
      return;
    }

    var voices = speechVoices.map(function(voice) {
      return {
        default: Boolean(voice.default),
        lang: voice.lang,
        localService: Boolean(voice.localService),
        name: voice.name,
        voiceURI: voice.voiceURI
      };
    });

    try {
      window.speechSynthesis.getVoices = function() {
        return voices.slice();
      };
    } catch (_err) {}

    try {
      setTimeout(function() {
        window.dispatchEvent(new Event('voiceschanged'));
      }, 0);
    } catch (_dispatchErr) {}
  };

  patchNavigatorProto();
  removeAutomationGlobals();
  patchPlugins();
  patchSpeechSynthesis();

  defineGetter(Object.getPrototypeOf(navigator), 'userAgentData', function() {
    return buildUserAgentData();
  });

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
