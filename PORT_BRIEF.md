# Порт-бриф: codex-plugin-cc → antigravity-plugin-cc

> Це стартовий промпт для нової сесії. Запусти сесію в цій папці
> (`antigravity-plugin-cc`) і встав цей файл як перше повідомлення, або скажи:
> **«Прочитай `PORT_BRIEF.md` повністю і виконай його».**

---

## Місія

Портувати плагін **codex-plugin-cc** на **Google Antigravity CLI (`agy`)** з
**повним паритетом функціоналу**. Результат — плагін `antigravity-plugin-cc`,
який дає в Claude Code ті самі можливості (рев'ю коду, делегування задач,
rescue, статуси, скасування), але виконавцем замість `codex` стає `agy`.

Цей репозиторій уже містить **чисте незмінене дерево codex-plugin-cc**
(гілка `main`, перший коміт — `chore: scaffold ... from codex-plugin-cc base`).
Це твоя база, з якої портуєш.

---

## Дві опорні точки (ОБОВ'ЯЗКОВО вивчи перед кодом)

1. **Ця база — `plugins/codex/`** — оригінальний плагін OpenAI. Порт FROM.
2. **Сусідня папка `../gemini-plugin-cc/`** — це **готовий, робочий порт цього ж
   плагіна на іншу agent-CLI** (Gemini CLI через ACP). Це твій взірець патерну
   порту: він показує ТОЧНО, які файли змінюються при переході з `codex` на іншу
   CLI і як.

   Вивчи дельту так (з папки `../gemini-plugin-cc`):
   ```bash
   git -C ../gemini-plugin-cc diff upstream/main HEAD --stat
   git -C ../gemini-plugin-cc diff upstream/main HEAD -- plugins/
   ```
   Порівняй `plugins/codex/` (там, в upstream) ↔ `plugins/gemini/` (HEAD).

> ⚠️ ВАЖЛИВО про відмінність від gemini-порту: Gemini-порт побудований навколо
> **ACP** (Agent Client Protocol, JSON-RPC over stdio з персистентним сервером
> `gemini --acp`). **Antigravity цього НЕ вміє** (див. нижче). Тому транспортний
> шар gemini-порту (`acp-broker.mjs`, `acp-client.mjs`, `gemini.mjs`) копіювати
> **не можна** — його треба переписати під `agy`. Усе інше (структура, команди,
> хуки, рендер, state, перейменування codex→X) — бери як зразок.

---

## Факти про Antigravity CLI (`agy`) — стан на момент написання

> Antigravity CLI новий і швидко змінюється. **Спочатку перевір усе нижче на
> реально встановленому `agy`** (`agy --version`, `agy --help`) і занотуй
> розбіжності — це визначає архітектуру. Не довіряй цьому списку наосліп.

- **Бінарник:** `agy`. Встановлення: `curl -fsSL https://antigravity.google/cli/install.sh | bash`.
- **Це наступник Gemini CLI**, переписаний на Go (швидший старт, менше пам'яті).
  Моделі: Gemini 3.x Pro/Flash, Claude Sonnet/Opus, GPT-OSS 120B.
- **❌ ACP не підтримується** (open feature request — `google-antigravity/antigravity-cli` issue #31). Тобто персистентного JSON-RPC stdio-сервера, як у gemini ACP чи `codex app-server`, **немає**.
- **Headless-режим:** `agy -p "PROMPT"` (one-shot, неінтерактивно).
- **`--output-format json` існує, але НЕНАДІЙНИЙ** — поточна порада спільноти:
  «don't build on a flag that doesn't work yet». Тобто базуй парсинг на plain-text
  з власними маркерами (напр. просити модель префіксувати відповідь
  `RESULT:` / спец-роздільниками), а JSON-режим додай як best-effort з фолбеком.
- **❗ Гоча №1 — non-TTY stdout dropping** (issue #76): `agy -p` **мовчки губить
  stdout, коли stdout не TTY** (pipe/subprocess/redirect) — exit code 0, але
  порожній вивід. Для плагіна, що спавнить `agy` як підпроцес, це блокер.
  Обхід — псевдо-TTY:
  ```bash
  script -qec 'agy -p "PROMPT"' /dev/null | sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g' | tr -d '\r'
  ```
  На macOS синтаксис `script` інший (`script -q /dev/null agy ...`) — перевір.
  Розглянь `node-pty` для крос-платформного псевдо-TTY з Node. Обов'язково
  додай валідацію: вивід непорожній + містить очікуваний маркер (не покладайся
  лише на exit code).
- **Auth:** через env `GEMINI_API_KEY` або `ANTIGRAVITY_API_KEY` (для headless),
  або інтерактивний логін (детектить SSH і друкує URL). `/antigravity:setup`
  має це перевіряти.
- **Резюм сесії по conversation ID** — зародковий (issue #7). Перевір, чи є вже.
  Якщо нема — емулюй неперервність контексту вручну (re-feed) або тримай turn
  без резюму. **Це головне архітектурне рішення — див. нижче.**

---

## Архітектура порту

### Що ЗАЛИШАЄТЬСЯ майже як є (transport-agnostic, перейменувати codex→antigravity)
- Команди: `cancel`, `result`, `review`, `rescue`, `status`, `setup`, `adversarial-review`.
- Агент: `codex-rescue` → `antigravity-rescue`.
- Хуки: `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`.
- Бібліотеки: `render.mjs`, `job-control.mjs`, `state.mjs`, `git.mjs`,
  `workspace.mjs`, `tracked-jobs.mjs`, `process.mjs`, `args.mjs`, `fs.mjs`,
  `prompts.mjs`, `broker-endpoint.mjs`, `broker-lifecycle.mjs` (адаптуй за потреби).
- Промпти/схеми: `prompts/`, `schemas/review-output.schema.json`.
- Інфра: `marketplace.json`, `plugin.json`, `README.md`, `CHANGELOG.md`,
  `NOTICE`, `LICENSE`, CI (`.github/workflows/pull-request-ci.yml`), `package.json`.

### Що ПЕРЕПИСУЄТЬСЯ (транспорт — суть порту)
- `plugins/codex/scripts/lib/codex.mjs` → `lib/antigravity.mjs` — рантайм, що
  запускає `agy`.
- `plugins/codex/scripts/lib/app-server.mjs` + `app-server-broker.mjs` +
  `app-server-protocol.d.ts` — **прибрати/замінити**. Codex тримав персистентний
  `codex app-server` (`spawn("codex", ["app-server"])`) і ганяв threads/turns по
  JSON-RPC. Для `agy` цього сервера нема → замість брокера зроби тонкий
  **runner**, що на кожен «turn» спавнить `agy -p` (через псевдо-TTY) і парсить
  вивід. Реши, чи потрібен брокер взагалі: для one-shot моделі, найімовірніше,
  достатньо runner-а + job-control для скасування (kill процесу).
- `codex-companion.mjs` → `antigravity-companion.mjs` (entrypoint).
- `tsconfig.app-server.json` — прибрати або переробити.
- Тести: `tests/fake-codex-fixture.mjs` → `fake-agy-fixture.mjs` (фейковий `agy`
  бінарник, який спавнять тести; має імітувати headless `agy -p`, у т.ч.
  поведінку виводу). Подивись, як це зроблено у `../gemini-plugin-cc/tests/fake-gemini-acp-fixture.mjs`.

### Мапа перейменувань
| codex | antigravity |
|---|---|
| `plugins/codex/` | `plugins/antigravity/` |
| plugin name `codex` | `antigravity` |
| marketplace `openai-codex` / owner OpenAI | `antigravity-cc` / owner Sergii Kozak (`kozaksv`) |
| `/codex:*` команди | `/antigravity:*` |
| skill `codex-cli-runtime` | `antigravity-cli-runtime` |
| skill `gpt-5-4-prompting` | `antigravity-prompting` (моделі Gemini 3 / Claude / GPT-OSS) |
| skill `codex-result-handling` | `antigravity-result-handling` |
| agent `codex-rescue` | `antigravity-rescue` |
| service name `claude_code_codex_plugin` | `claude_code_antigravity_plugin` |
| env/конфіг із `CODEX_*` | `ANTIGRAVITY_*` (де доречно) |
| версія | старт `1.0.0` |

---

## Процес (дисципліна обов'язкова)

1. **Скіли спочатку.** Активуй `superpowers:brainstorming` для проєктування
   транспортного шару (one-shot runner vs. псевдо-брокер; як емулювати
   thread/resume; як парсити вивід). Це найризикованіше рішення — спершу
   спроектуй, потім кодь.
2. **Дослідження живого `agy`.** Постав/знайди `agy`, прозондуй реальний CLI
   (`--help`, headless, non-TTY, json, resume). Запиши факти в `docs/` репо.
3. **План.** `superpowers:writing-plans` — розпиши порт пофайлово.
4. **TDD.** `superpowers:test-driven-development` — є набір тестів
   (`tests/runtime.test.mjs`, `commands.test.mjs`, `render.test.mjs`,
   `git.test.mjs`, `state.test.mjs`, `process.test.mjs`,
   `broker-endpoint.test.mjs`, `bump-version.test.mjs`). Порти/адаптуй тести
   разом із кодом. `npm test` має бути зеленим.
5. **Верифікація.** `superpowers:verification-before-completion` — реальний
   smoke-тест: встанови плагін локально, виконай `/antigravity:setup`,
   `/antigravity:review`, `/antigravity:rescue` на справжньому `agy`.

---

## Чеклист паритету (acceptance criteria)

- [ ] `/antigravity:setup` — детектить `agy`, перевіряє auth (env/login), вмикає/вимикає stop-review-gate.
- [ ] `/antigravity:review` + `/antigravity:adversarial-review` — дають структуроване рев'ю (з фолбеком парсингу, бо json ненадійний).
- [ ] `/antigravity:rescue` (+ агент `antigravity-rescue`) — делегує задачу `agy` через Agent tool (не через Skill, щоб уникнути рекурсії — див. історію codex issue #234/#235).
- [ ] `/antigravity:status`, `/antigravity:result`, `/antigravity:cancel` — керують job'ами (`$ARGUMENTS` мають бути в лапках — codex issue #168).
- [ ] Хуки `session-lifecycle` і `stop-review-gate` працюють.
- [ ] non-TTY вивід `agy` надійно захоплюється (псевдо-TTY) — критично.
- [ ] Скасування job'а реально вбиває процес `agy` (process tree kill).
- [ ] `npm test` зелений; CI зелений.
- [ ] README: встановлення `agy`, передумови, auth, і **застереження про non-TTY/json**.
- [ ] `marketplace.json` / `plugin.json` коректні, версія `1.0.0`.
- [ ] Жодних залишків слів `codex` / `Codex` / `app-server` / `acp` у фінальному `plugins/antigravity/` (`grep -ri 'codex\|app-server\|\bacp\b' plugins/antigravity`).

---

## Перші кроки в новій сесії

1. Прочитай цей бриф і дельту gemini-порту (`git -C ../gemini-plugin-cc diff upstream/main HEAD`).
2. Перевір `agy` (`agy --version`, `agy --help`); якщо не встановлено — постав і занотуй реальні прапорці.
3. `brainstorming` → спроектуй транспорт під реальні можливості `agy`.
4. `writing-plans` → пофайловий план; потім TDD-виконання.
5. Зелені тести + ручний smoke-тест → коміт.

## Корисні команди
```bash
git -C ../gemini-plugin-cc diff upstream/main HEAD --stat   # карта порту-взірця
git fetch upstream && git diff upstream/main HEAD            # що змінив відносно codex-бази
grep -rIn "codex\|Codex" plugins/antigravity                # залишки після перейменування
```

> Пріоритет інструкцій: явні вказівки користувача > skills (superpowers) >
> дефолтна поведінка. Якщо щось у брифі суперечить тому, що користувач скаже в
> сесії — слухай користувача.
