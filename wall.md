# Wall

## Что уже сделано

- Вынесен единый proxy source of truth в `src/proxy.ts`.
  - Один и тот же `.env` proxy теперь используется для:
    - Playwright / Edge
    - Node-side HTTP клиентов
    - control-plane запросов к `2captcha`
  - Добавлены proxy-aware `http`/`https` agents.

- Убран старый агрессивный stealth-path.
  - `configureApolloPage()` больше не инжектит ручной stealth script.
  - Удалён runtime-импорт `applyStealthScript`.
  - Из browser launch убраны антидетект-флаги вроде `--disable-blink-features=AutomationControlled`.
  - Блокировка ресурсов ослаблена до минимальной, чтобы не сыпать лишними `ERR_FAILED` на аналитике и внешних скриптах.

- Переведён браузерный раннер на persistent Edge context.
  - Добавлен `src/browser-launch.ts`.
  - Worker теперь использует установленный `msedge` через Playwright persistent context.
  - Профиль хранится в `storage/edge-profile/<jobId>`.

- Добавлен структурированный browser diagnostics.
  - Новый `src/browser-diagnostics.ts`.
  - Логируются:
    - console messages
    - page errors
    - request failures
    - popup diagnostics

- Переписан `src/captcha-solver.ts`.
  - Убран hot-path через `2captcha-ts`.
  - Реализован собственный proxy-aware transport для `in.php` / `res.php`.
  - Теперь control-plane запросы к `2captcha` действительно идут через proxy из `.env`.
  - Для reCAPTCHA в solve payload прокидывается live browser `user-agent`.

- Обновлён Apollo direct HTTP client в `src/extractor.ts`.
  - Убраны хардкоженные Brave-style headers.
  - Запросы теперь строятся из:
    - реальных cookies / csrf
    - актуальных request headers из браузера
    - live Edge user-agent
  - Добавлен helper `postApolloJson()`.

- Переписан `src/crawler.ts`.
  - Убрана зависимость от `PlaywrightCrawler`/Crawlee для этого critical path.
  - Логика теперь напрямую управляет persistent Edge context.
  - Разделена обработка:
    - `/api/v1/mixed_people/search`
    - `/api/v1/mixed_people/search_metadata_mode`
  - Если Apollo отдаёт `search_metadata_mode`, это больше не считается people payload.
  - После metadata response выполняется replay canonical people search через тот же auth/session/proxy path.

- Добавлен разбор metadata payload в `src/leads-scraper.ts`.
  - Появился `parseApolloMetadataResponse()`.
  - Ошибки схемы metadata и people теперь различаются явно.

- Обновлён worker flow в `src/worker.ts`.
  - Прокси логируется через новый unified proxy layer.
  - reCAPTCHA solve использует live browser UA.

- Обновлён smoke path.
  - `src/smokeTest.ts` теперь использует persistent Edge context и новые diagnostics.

- Добавлен egress-check.
  - Новый `src/debug-egress.ts`
  - Новый npm script: `npm run debug:egress`

- Усилен auth flow для Microsoft logout/interstitial cases.
  - Добавлен `ManualAuthenticationRequiredError`.
  - Если Microsoft выбрасывает страницу вида `logged out from multiple places`, flow больше не падает мгновенно.
  - `AuthManager` теперь может дождаться ручного восстановления сессии в открытом браузере и продолжить работу.

## Что уже подтверждено

- `npm run build` проходит.
- `npm run debug:egress` проходит.
  - browser IP = proxy IP
  - node IP = proxy IP
  - `2captcha` transport IP = proxy IP
- Пользователь подтверждал: логин в Apollo в принципе проходит успешно.
- `npm run smoke` от `2026-04-16` дошёл через Microsoft OAuth до post-login этапа, но упёрся в интерактивный Microsoft security/logout state:
  - `For security reasons, Microsoft logged the account out because it was used from multiple places`
  - это не похоже на локальный IP leak или старый кодовый crash
  - после этого добавлен manual-auth wait path вместо мгновенного hard fail

## Что ещё осталось доделать / проверить

- Прогнать полный worker run после изменений.
  - Подтвердить, что flow доходит до Apollo people search без возврата к Turnstile failure.
  - Подтвердить, что `search_metadata_mode` корректно логируется как metadata.
  - Подтвердить, что replay canonical `/api/v1/mixed_people/search` реально возвращает people payload.

- Проверить финальный extraction happy-path end-to-end.
  - leads сохраняются в SQLite
  - export создаётся в `exports/`
  - в логах нет старых `__name is not defined`
  - в run-логах нет признаков локального IP leakage

- Повторно прогнать `npm run smoke` или worker после стабилизации Microsoft account state.
  - ideally без параллельных сессий того же аккаунта
  - проверить, что новый manual-auth path действительно позволяет восстановиться без перезапуска worker

- Добить housekeeping.
  - При желании удалить остаточный неиспользуемый stealth dependency из lockfile / установить package state в полное соответствие `package.json`.
  - При желании убрать теперь уже неиспользуемые константы/ветки вроде `APOLLO_PROXY_BYPASS_LIST`, если после финального прогона они точно не нужны.

## Текущий риск

- Главный незакрытый пункт сейчас не логин и не утечка IP.
- Главный незакрытый пункт: подтвердить на реальном worker-run, что Apollo после `search_metadata_mode` действительно даёт recoverable people search response через replay, а не уходит в другой variant API flow.
- Дополнительный внешний риск: Microsoft может выбрасывать account-security/logout interstitial при конкурентном использовании учётки, и это нельзя полностью исправить только кодом scraper-а.
