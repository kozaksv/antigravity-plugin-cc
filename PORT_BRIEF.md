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

> Уточнення «паритету»: йдеться про **паритет команд і UX у Claude Code**, а не про
> повний runtime-паритет із codex app-server. `agy` не має нативних threads/resume,
> тож частина можливостей емулюється зверху (стор сесій, re-feed) — поведінка та сама,
> механіка інша.

Цей репозиторій уже містить **чисте незмінене дерево codex-plugin-cc**
(гілка `main`, перший коміт — `chore: scaffold ... from codex-plugin-cc base`).
Це твоя база, з якої портуєш.

> Уточнення «чистого дерева»: мається на увазі **відстежуваний (git-tracked) код
> плагіна**. Локальний `.claude/settings.local.json` (дозволи сесії, напр.
> `Skill(gemini:rescue)`) — це untracked артефакт робочої сесії, а **не** залишок
> іншого порту. Додай `.claude/` до `.gitignore`, якщо його там нема, щоб не
> заплутати наступні сесії.

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
  > ⚠️ Передача prompt через argv небезпечна для **довгих** prompt (re-feed історії):
  > ризик `ARG_MAX`, shell-escaping і **витоку prompt у process list** (`ps`).
  > Перевір на живому CLI, чи `agy` читає prompt зі **stdin або файлу**; якщо так —
  > використовуй це. Спавни через argv-масив **без shell** (`execFile`, не `exec`),
  > і встанови hard-limit на довжину + summarization ДО spawn.
- **`--output-format json` існує, але НЕНАДІЙНИЙ** — поточна порада спільноти:
  «don't build on a flag that doesn't work yet». Тобто базуй парсинг на plain-text
  з **конкретними власними маркерами** (визнач їх один раз і тримай у `prompts/`,
  щоб промпт і runner не розходились). Рекомендовані роздільники, які важко
  переплутати з контентом:
  ```
  ===ANTIGRAVITY_RESULT_BEGIN===
  ... відповідь моделі ...
  ===ANTIGRAVITY_RESULT_END===
  ```
  JSON-режим додай як best-effort: спершу спробуй `JSON.parse`; якщо парс упав
  АБО в об'єкті нема очікуваних ключів — **детект «json не працює»** і фолбек на
  маркерний парсинг. Не вгадуй за exit code.
- **❗ Гоча №1 — non-TTY stdout dropping** (issue #76): `agy -p` **мовчки губить
  stdout, коли stdout не TTY** (pipe/subprocess/redirect) — exit code 0, але
  порожній вивід. Для плагіна, що спавнить `agy` як підпроцес, це блокер.
  Обхід — псевдо-TTY. **Розробка на macOS (darwin) → основний приклад для macOS:**
  ```bash
  # macOS / BSD script: прапорці ПЕРЕД командою, команда — окремими аргументами
  script -q /dev/null agy -p "PROMPT" | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' | tr -d '\r'
  ```
  ```bash
  # Linux util-linux script (для CI на ubuntu): -c з командою-рядком
  script -qec 'agy -p "PROMPT"' /dev/null | sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g' | tr -d '\r'
  ```
  Синтаксис `script` несумісний між платформами — **детект ОС у runner'і** і обирай
  гілку, або (краще) використай `node-pty` як крос-платформний псевдо-TTY.
  > Рішення по `node-pty`: це нативний (C++) модуль → додає крок компіляції і
  > ризик при оновленні Node. Зваж під час brainstorming: (а) `node-pty` як
  > залежність плагіна, чи (б) shell-обхід через `script` з детектом ОС і
  > **без** нативних залежностей. Для CI варіант (б) стабільніший. Прийми рішення
  > явно і зафіксуй у `docs/`.
  > 🔎 **Альтернативний обхід (web-перевірка, 2026-06):** замість захоплення stdout
  > читати транскрипт сесії з файлу
  > `~/.antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`. Може бути
  > надійніше і крос-платформніше за псевдо-TTY (не залежить від `script`/`node-pty`),
  > але прив'язує до внутрішнього формату `agy` — **звір шлях/формат на живому CLI**
  > перед тим, як будувати на цьому. Тримай псевдо-TTY як запасний варіант.
  > ⚠️ Якщо обереш transcript-стратегію — runner мусить **надійно мапити процес →
  > шлях транскрипту** (як дізнатися `<id>` саме цього спавна?). При паралельних
  > job'ах це race condition: snapshot каталогу `brain/` до/після spawn, lock на
  > job, звірка mtime/pid/session-id, і тест на ≥2 одночасні job'и.
  Обов'язково додай валідацію: вивід непорожній + містить очікуваний маркер (не
  покладайся лише на exit code).
- **Auth:** через env (для headless) або інтерактивний логін (детектить SSH і
  друкує URL). `/antigravity:setup` має це перевіряти. **Читаються обидва ключі,
  але `ANTIGRAVITY_API_KEY` має ВИЩИЙ пріоритет** (web-перевірка, 2026-06; звір на
  живому CLI) — тож `setup` перевіряє його першим, `GEMINI_API_KEY` як фолбек.
- **Резюм сесії по conversation ID — нативного НЕМА** (web-перевірка, 2026-06).
  ⚠️ Раніше тут згадувався issue #7 як «зародковий resume» — це **хибно**: issue #7
  насправді про несумісність прапорця `--model` і краші AES-NI, не про резюм.
  Тобто локальний стор сесій + re-feed історії — **безальтернативне** архітектурне
  рішення, а не «на випадок якщо нативного нема». **Головне рішення — див. нижче.**
  > ⚠️ Re-feed **не масштабується**: для rescue з багатьма turn'ами повна історія
  > переросте контекст-вікно `agy`. Заклади ліміт turn'ів у сесії + стратегію при
  > переповненні (усічення найстаріших / summarization попередніх turn'ів у
  > короткий конспект). Без цього довгі rescue-сесії — блокер, а не гіпотетика.

---

## Архітектура порту

### Що ЗАЛИШАЄТЬСЯ майже як є (transport-agnostic, перейменувати codex→antigravity)
- Команди: `cancel`, `result`, `review`, `rescue`, `status`, `setup`, `adversarial-review`.
- Агент: `codex-rescue` → `antigravity-rescue`.
- Хуки: `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`.
- Бібліотеки: `render.mjs`, `job-control.mjs`, `git.mjs`,
  `workspace.mjs`, `tracked-jobs.mjs`, `process.mjs`, `args.mjs`, `fs.mjs`,
  `prompts.mjs` (адаптуй за потреби).
  - ⚠️ `state.mjs` — **залишається, але РОЗШИРЮЄТЬСЯ**: він стає базою стору сесій
    для емуляції `thread/list`/`resume` (див. таблицю RPC нижче). Це не просте
    перейменування — закладай роботу.
  - ⚠️ `broker-endpoint.mjs` / `broker-lifecycle.mjs` — **НЕ в цьому списку.** Вони
    обслуговують персистентний брокер app-server'а, якого в `agy` нема → їхня доля
    вирішується в розділі «що переписується» (найімовірніше — видалити). Не
    переноси їх наосліп як «transport-agnostic».
- Промпти/схеми: `prompts/`, `schemas/review-output.schema.json`.
- Інфра (тільки метадані/перейменування): `plugin.json`, `CHANGELOG.md`,
  `NOTICE`, `LICENSE`. `marketplace.json` — теж залишається структурно, але
  зміни `name`/`owner`/`plugins[].name`/`source` за мапою перейменувань нижче.

> ⚠️ **Не плутай transport-agnostic з «не зав'язаний на codex».** Наступні файли
> виглядають як «інфра», але **жорстко зашиті на бінарник/протокол codex** і
> ламаються без правок — їх винесено в розділ «що переписується»:
> `package.json` (`prebuild`/`build`), CI workflow, `scripts/bump-version.mjs`,
> `README.md`.

### Що ПЕРЕПИСУЄТЬСЯ (транспорт — суть порту)
- `plugins/codex/scripts/lib/codex.mjs` → `lib/antigravity.mjs` — рантайм, що
  запускає `agy`.
- `plugins/codex/scripts/lib/app-server.mjs` + `app-server-broker.mjs` +
  `app-server-protocol.d.ts` — **прибрати/замінити**. Codex тримав персистентний
  `codex app-server` (`spawn("codex", ["app-server"])`) і ганяв threads/turns по
  JSON-RPC. Для `agy` цього сервера нема → замість брокера зроби тонкий
  **runner**, що на кожен «turn» спавнить `agy -p` і надійно захоплює вивід через
  **verified output strategy** (transcript.jsonl якщо підтверджено на живому CLI,
  інакше псевдо-TTY як фолбек — див. секцію non-TTY вище), потім парсить.
  Реши, чи потрібен брокер взагалі: для one-shot моделі, найімовірніше,
  достатньо runner-а + job-control для скасування (kill процесу).

  > ❗ **App-server — це не лише «транспорт».** `codex.mjs` ганяє через нього цілий
  > stateful RPC-API (реальні методи в `codex.mjs`): `thread/start`,
  > `thread/resume`, `thread/list`, `thread/name`, `turn/start`,
  > `turn/interrupt`, `account/read`, `config/read`, `login`. `agy -p` — це
  > **stateless one-shot**, у нього такого API НЕМА. Кожен метод треба свідомо
  > **емулювати**, інакше частина команд просто не матиме чим працювати. План:
  >
  > | RPC у codex | Чим замінити в antigravity |
  > |---|---|
  > | `thread/start`, `turn/start` | один спавн `agy -p` + verified output strategy (transcript.jsonl / псевдо-TTY-фолбек) |
  > | `turn/interrupt` | graceful kill дерева процесів (SIGTERM → SIGKILL) + cleanup |
  > | `thread/resume`, `thread/list`, `thread/name` | **локальний стор сесій** (через `state.mjs`, напр. `.antigravity/sessions/<id>.json` з історією turn'ів); резюм = re-feed історії у промпт |
  > | `account/read`, `login` | детект auth: env `ANTIGRAVITY_API_KEY` (пріоритет) → `GEMINI_API_KEY` (фолбек) → стан логіну `agy`; читання конфіг-файлів з диска |
  > | `config/read` | читати конфіг `agy` з диска замість RPC. Кандидат шляху (web, 2026-06): `~/.config/antigravity/config.toml` — **звір на живому CLI** |
- `broker-endpoint.mjs` + `broker-lifecycle.mjs` (+ `broker-endpoint.test.mjs`) —
  **рішення за замовчуванням: ВИДАЛИТИ.** Вони існують, щоб тримати персистентний
  `codex app-server` живим між викликами. У stateless-моделі `agy -p` брокера
  нема, тож runner + job-control (`tracked-jobs.mjs`) покривають усе. Якщо під час
  brainstorming виявиться, що пул фонових процесів `agy` потребує власного
  координатора — тоді переписати під нього, але **не зберігати назву/код
  app-server-брокера** (інакше зламається grep-перевірка на `app-server` у чеклісті).
- `codex-companion.mjs` → `antigravity-companion.mjs` (entrypoint).
- `tsconfig.app-server.json` — **прибрати** (без app-server немає `.d.ts` для
  компіляції; TS-білд app-server-протоколу більше не потрібен).
- Тести: `tests/fake-codex-fixture.mjs` → `fake-agy-fixture.mjs` (фейковий `agy`
  бінарник, який спавнять тести; має імітувати headless `agy -p`, у т.ч. маркери
  виводу і поведінку non-TTY).
  > ⚠️ `../gemini-plugin-cc/tests/fake-gemini-acp-fixture.mjs` — це fixture для
  > **ACP** (персистентний JSON-RPC stdio-сервер). Структура `agy -p` (stateless
  > one-shot, друкує текст і виходить) **принципово інша** — НЕ копіюй ACP-логіку.
  > Бери звідти лише загальний підхід «фейковий бінарник на шляху», а саму
  > поведінку пиши під one-shot: прочитати промпт, віддати марковану відповідь,
  > вийти з кодом 0. Можеш відтворити і баг non-TTY (порожній stdout без псевдо-TTY),
  > щоб тест ловив регресію обходу.

### Збірка, CI та реліз (теж зав'язані на codex — переписати)
- **`package.json`** (корінь):
  - `prebuild` зараз = `codex app-server generate-ts ...` → **видали** (нема
    app-server → нема генерації типів).
  - `build` = `tsc -p tsconfig.app-server.json` → **видали або заміни**
    (найімовірніше білд взагалі не потрібен; залиш `test`).
  - онови `name`/`description` (з `@openai/codex-plugin-cc` на antigravity).
- **`.github/workflows/pull-request-ci.yml`**: крок `Install Codex CLI`
  (`npm install -g @openai/codex`) → встановлення `agy`
  (`curl -fsSL https://antigravity.google/cli/install.sh | bash`); прибери крок
  `Run build`, якщо білд видалено. Переконайся, що тести в CI не вимагають
  справжнього `agy` (мають іти на `fake-agy-fixture`).
  > ⚠️ curl-install у CI крихкий: потребує правильного PATH, може потребувати
  > sudo, і `install.sh` тягне **latest** `agy` → оновлення може зламати CI будь-коли.
  > Найкраще — щоб тести взагалі не залежали від справжнього `agy` (повністю на
  > fixture), а реальний `agy` ставити лише в окремому опціональному smoke-job'і
  > з **запіненою версією** (`AGY_VERSION=...`), не в основному gate.
- **`scripts/bump-version.mjs`**: у масиві `TARGETS` зашито
  `plugins/codex/.claude-plugin/plugin.json` та пошук плагіна за `name === "codex"`
  у marketplace → онови шлях на `plugins/antigravity/...` і ім'я на `"antigravity"`.
  Старт версії — `1.0.0` (не успадковуй `1.0.4` з codex-бази).
- **`README.md`**: повністю переписати під antigravity. Зокрема розділ про
  конфіг (`~/.codex/config.toml` / `.codex/config.toml`, моделі `gpt-5.4-*`) →
  замінити на реальний конфіг `agy` і моделі Gemini 3 / Claude / GPT-OSS; додати
  встановлення `agy`, auth (env/login) і **застереження про non-TTY/json**.

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
   спроектуй, потім кодь. Спроектуй явно три недооцінені місця:
   - **Стор сесій** для емуляції `thread/list`/`resume` (re-feed історії). Це
     обов'язкове рішення, бо stateless `agy -p` не має тредів. Визнач: формат файлу
     (`.antigravity/sessions/<id>.json`), **ліміт turn'ів + стратегію при
     context-overflow** (усічення/summarization), і reconciliation для
     `thread/list` (як стор синхронізується з реальністю, якщо процес `agy` упав).
   - **Cleanup при скасуванні**: process-tree-kill `agy` посеред turn'а може
     лишити репо в брудному стані (наполовину застосовані git-патчі, lock-файли).
     Передбач graceful shutdown і прибирання, а не лише `kill -9`. Конкретизуй:
     `SIGTERM` → таймаут (напр. 5 с) → `SIGKILL`; знімок `git` ДО turn'а (stash/
     stash-ref або записати `git status`/`HEAD`), щоб після kill можна було
     відкотити напівзастосовані зміни. Врахуй, що `agy -p` — black box: ти не
     контролюєш його git-операції, тож рамку (snapshot/restore) будуй ЗВЕРХУ.
     > ❗ **НЕ роби blind `reset`/`stash pop`.** Плагін працює в живому репо —
     > автоматичний restore може знести **зміни користувача, що існували ДО**
     > запуску. Зафіксуй pre-run dirty state і відкочуй ЛИШЕ те, що зробив turn
     > (diff проти знімка), а не все. Безпечніше — ізолювати mutable rescue-job'и
     > через git worktree або per-workspace lock.
   - **Крихкість plain-text парсингу** для `review`: будь-яке відхилення моделі у
     форматуванні зламає розбір. Маркери + сувора валідація + явний фолбек, а не
     один крихкий regex.
2. **Дослідження живого `agy`.** Постав/знайди `agy`, прозондуй реальний CLI
   (`--help`, headless, non-TTY, json, resume). Запиши факти в `docs/` репо.
3. **План.** `superpowers:writing-plans` — розпиши порт пофайлово.
4. **TDD.** `superpowers:test-driven-development` — є набір тестів
   (`tests/runtime.test.mjs`, `commands.test.mjs`, `render.test.mjs`,
   `git.test.mjs`, `state.test.mjs`, `process.test.mjs`,
   `broker-endpoint.test.mjs`, `bump-version.test.mjs`). Порти/адаптуй тести
   разом із кодом. `npm test` має бути зеленим. Зауваж: `broker-endpoint.test.mjs`
   зникає разом із брокером (див. вище); натомість додай тести на runner (`agy -p`
   через fixture), маркерний парсинг + фолбек, стор сесій і cleanup при kill.
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
- [ ] non-TTY вивід `agy` надійно захоплюється (verified output strategy: transcript.jsonl якщо підтверджено, інакше псевдо-TTY) — критично.
- [ ] Скасування job'а реально вбиває процес `agy` (process tree kill) **і прибирає за собою** (без напівзастосованих патчів / dangling lock-файлів).
- [ ] Емуляція стану: `setup`/auth працюють без `account/read`/`config/read` (env + диск); резюм задач — через локальний стор сесій (re-feed), бо тредів у `agy` нема.
- [ ] Re-feed має ліміт turn'ів + стратегію при context-overflow (усічення/summarization) — довгі rescue не падають.
- [ ] Паралельні job'и `agy -p` обмежені (ліміт одночасних процесів); кілька фонових `/antigravity:review --background` не з'їдають машину.
- [ ] Реальний шлях/формат конфіг-файлів `agy` з'ясовано на живому CLI і задокументовано в `docs/`; `setup` читає його правильно.
- [ ] Пріоритет auth-ключів (`GEMINI_API_KEY` vs `ANTIGRAVITY_API_KEY`) перевірено на живому `agy` (який реально читається) — `setup` не перевіряє хибний ключ.
- [ ] Збірка/реліз очищені від codex: `package.json` без `prebuild`/`build` на app-server; `bump-version.mjs` цілить у `plugins/antigravity/...` та `name:"antigravity"`.
- [ ] CI ставить `agy` (curl), а не `@openai/codex`; тести йдуть на `fake-agy-fixture` без живого `agy`.
- [ ] `npm test` зелений; CI зелений.
- [ ] README переписаний під antigravity: встановлення `agy`, auth, конфіг `agy` (не `~/.codex/config.toml`), і **застереження про non-TTY/json**.
- [ ] Версія `1.0.0` синхронна в УСІХ місцях: `package.json`, `package-lock.json`, `plugins/antigravity/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`metadata.version` + `plugins[antigravity].version`), `CHANGELOG.md`. `npm run check-version` зелений.
- [ ] `marketplace.json` / `plugin.json` коректні (`name`/`owner`/`source`).
- [ ] `.claude/` у `.gitignore` (локальні settings не потрапляють у дерево).
- [ ] Жодних `codex`/`app-server`/`acp` у **runtime/import/command** посиланнях фінального `plugins/antigravity/` (`grep -ri 'codex\|app-server\|\bacp\b' plugins/antigravity`). Allowlist для не-рантайму: `LICENSE`, `NOTICE`, `CHANGELOG.md`, docs/історичні згадки — їх перевіряй очима, не валь автоматично.

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
