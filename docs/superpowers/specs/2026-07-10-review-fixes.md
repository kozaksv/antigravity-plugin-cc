# Spec: hardening-реліз плагіна antigravity (review-fixes, ціль 1.0.2)

Дата: 2026-07-10
Джерело: `docs/superpowers/specs/2026-07-10-review-fixes-design.md` (узгоджений брейншторм)
Скоуп: єдиний пакет `plugins/antigravity/**` + доки в корені. Монорепо нема.

## 1. Проблема

Повне ревью плагіна (рантайм `plugins/antigravity/scripts/**`, хуки, команди, скіли, промпти, схема, доки; 74/74 тести зелені; `claude plugin validate` PASS) виявило 2 критичні, ~8 середніх і ~10 дрібних дефектів. Спільна риса критичних — розрив між тим, що плагін **обіцяє** (валідний JSON зі схеми, read-only ізоляція, дієві прапорці) і тим, що **робить**. Дрібні — накопичений борг (мертвий код, typos, неконсистентна атрибуція, метадані). Ціль фічі — закрити **всі** знахідки одним hardening-релізом 1.0.2; обсяг фіксований, деталі імплементації уточнюються.

Джерело правди про поведінку `agy` 1.0.10 — `docs/agy-cli.md` (live probe): `--sandbox` існує; `-p` бере промпт лише з argv; `--print-timeout` advisory; RESOURCE_EXHAUSTED видно лише в `--log-file`.

## 2. Підхід

Спиратися на наявні механізми, нічого не вигадувати:
- Локи — той самий **O_EXCL**-патерн, що вже в `lib/job-slots.mjs` (retry ~50ms, ліміт ~5s, stale-reclaim по mtime+dead-pid). Переносимо на `state.lock`.
- Каскад таймаутів — через **env-fallback**, який `runOneShot` уже вміє читати як запасний до `options.timeoutMs`.
- Ізоляція — реальний прапорець `agy --sandbox` замість самопроголошеної «read-only».
- Effort — мапінг на **суфікс назви моделі** (`(Low|Medium|High)`), бо в agy effort закодовано саме там.
- Стан — стандартний XDG-ланцюг замість `/tmp`.
- Кожна знахідка супроводжується юніт- та/або argv-тестом (fake-agy fixture розширюється перевірками argv).

Порядок імплементації: спершу критичні (A1, A2), далі середні (B*), тоді дрібні (C*), наприкінці `bump-version 1.0.2` + `check-version`. Гілка A2 (sandbox всюди vs лише inline-diff) обирається ручним пробом з реальним agy на етапі імплементації; дефолт дизайну — sandbox для всіх не-write запусків.

## 3. Зміни

### 3.1 Data model / стан (`lib/state.mjs`)

- **Директорія стану (B4)**: ланцюг `CLAUDE_PLUGIN_DATA` → `XDG_STATE_HOME/antigravity-companion` → `~/.local/state/antigravity-companion`. Прибрати `os.tmpdir()`-фолбек. `mkdirSync` з `mode: 0o700`. Змінюється `resolveStateDir` (`FALLBACK_STATE_ROOT_DIR`). Міграції старого /tmp-стану НЕ робимо — job-и короткоживучі; зафіксувати в CHANGELOG.
- **Блокування запису (B5)**: новий `state.lock` (O_EXCL, патерн job-slots) береться **лише на write-точках входу і без вкладення**. `updateState` виконує read→mutate→write повністю під одним локом, викликаючи всередині **приватний `saveStateUnlocked`** (без власного лока); публічний `saveState` (для прямих викликів) бере той самий лок один раз навколо свого write. Лок ніколи не вкладається сам у себе (O_EXCL нереентрантний — вкладення = самодедлок/EEXIST). Запис `state.json` — **атомарний write-and-rename**: серіалізувати в тимчасовий `state.json.<pid>.tmp` у тій самій директорії, `fs.renameSync` поверх цільового (rename атомарний на локальній FS). Прямий `fs.writeFileSync` у цільовий файл прибрати — інакше конкурентний читач (`loadState`) може прочитати обрізаний/порожній файл, впасти на `JSON.parse` і мовчки скотитись у `defaultState()`, стерши історію job-ів. Захищає від конкурентних писарів: background-worker, `/antigravity:cancel`, session-хук.
- Формат `state.json` (jobs[]) **не змінюється** — лише механіка доступу.

### 3.2 API / argv- та prompt-контракт

Точка збірки argv — `buildAgyArgs`; виконання — `executeTaskRun`/`runOneShot` (`lib/antigravity.mjs`); CLI-парсинг — `antigravity-companion.mjs`.

- **A1 — схема в промпт**: у `prompts/adversarial-review.md`, блок `<structured_output_contract>`, додати плейсхолдер `{{OUTPUT_SCHEMA}}`; `buildAdversarialReviewPrompt` інтерполює `JSON.stringify(schema, null, 2)` з `schemas/review-output.schema.json` (включно з top-level `next_steps`). Прибрати мертвий `outputSchema: readOutputSchema(REVIEW_SCHEMA)` з виклику `runTurn` (runOneShot його ігнорує).
- **A2 — sandbox**: `buildAgyArgs` додає `--sandbox` для не-write запусків (review, adversarial-review, task без `--write`). Не додає для `task --write`. Escape hatch: env `ANTIGRAVITY_COMPANION_NO_SANDBOX=1` вимикає. `--dangerously-skip-permissions` лишається (без нього headless-agy висне) — це чесно документується.
- **B1 — effort → модель**: значення звузити до `low|medium|high` (інше → помилка з підказкою). Базова модель = задана (аліас/label) або дефолт `Gemini 3.5 Flash`; суфікс `(Low|Medium|High)` підставляється/замінюється за effort. Якщо label не має суфікс-патерну (напр. `Claude Sonnet 4.6 (Thinking)`) — чітка помилка «effort не застосовний до цієї моделі». Прапорець доходить до agy через `--model "<label> (High)"`.
- **B2 — таймаути**: (а) хук читає `input.stop_hook_active === true` → logNote + allow (жодного повторного ревью в тому ж stop-циклі); (б) каскад: agy-turn 780s < spawnSync 840s < hook 900s. Хук передає ліміт у task через env `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS` (runOneShot читає як fallback до `options.timeoutMs`). `hooks.json` Stop timeout лишається 900.
- **B3 — SessionEnd teardown**: `hooks.json` SessionEnd timeout 5 → 60; у teardown `terminateProcessTree(pid, { graceMs: 2000 })`.
- **B6 — self-collect untracked**: у гілці `includeDiff === false` (`git.mjs`) інлайнити лише список імен+розмірів (перші ~200, далі «…and N more»), без тіл файлів.
- **B7 — Windows shell**: `lib/process.mjs` — на win32 **не прибирати shell**, а лише прибрати `process.env.SHELL`-оверрайд: `shell: process.platform === "win32"` (тобто `true` = cmd.exe на win32, `false` деінде). Причина: `git`, `npm`, а часто й обгортки agy лежать у PATH як `.cmd`/`.bat`, і без `shell:true` (або явного резолву розширення) `spawnSync` дасть ENOENT — зламає всі git-функції (снапшоти, дифи, коміти) на Windows. Поточний `process.env.SHELL || true` небезпечний тим, що POSIX-шлях у `SHELL` (напр. з git-bash) перехопить win32-спавни; фіксимо саме це, лишаючи cmd.exe-резолв `.cmd`/`.bat`/`.exe`. Для `binaryAvailable` на win32 — додатковий фолбек-проба `<cmd>.cmd` (напр. `npm.cmd`) як belt-and-suspenders.
- **C1 — auth-probe cwd**: `getAntigravityAuthStatus` виконувати з одноразового `mkdtemp`-каталогу (не з workspace), щоб не перетирати `last_conversations.json[cwd]` і не ламати `--resume-last`.
- **C8 — splitRawArgumentString бекслеші** (`lib/args.mjs`): бекслеш екранує лише наступні пробіл/лапку/бекслеш; перед іншими символами — literal (`C:\Users\x` виживає, `\"` досі екранує).
- **C9 — `--timeout-ms 0`** (`antigravity-companion.mjs`): замінити `|| DEFAULT` на `Number.isFinite`-перевірку; 0 = миттєвий снапшот без очікування.

### 3.3 UI / доки, команди, метадані

- **A2 доки**: README — новий розділ «Security posture» (чесно про `--dangerously-skip-permissions`, що дає/не дає `--sandbox`, що write-задачі не ізольовані). Замінити тричі-повторену фразу «will not perform any changes» (README:9,97,121) на чесне формулювання.
- **B1 доки**: оновити значення й приклади effort у `commands/rescue.md`, `agents/antigravity-rescue.md`, `skills/antigravity-cli-runtime/SKILL.md`.
- **B8 foreground timeout**: у foreground-блоках `commands/review.md`, `commands/adversarial-review.md` і foreground task в `agents/antigravity-rescue.md` явно інструктувати Bash-виклик `timeout: 600000` (дефолт Claude Code 120s замалий).
- **C2 чесні доки resume**: поведінку НЕ міняти (session-scoped — свідомий дизайн). Виправити брехливий коментар `lib/antigravity.mjs` (~811-817), README-фразу «continue the latest rescue thread for this repo» → «в межах поточної сесії», згадки в rescue.md/skill за потреби.
- **C3 мертвий код (видалити)**: `fs.mjs` → `ensureAbsolutePath`, `safeReadFile` (`createTempDir` ЛИШАЄТЬСЯ — потрібен C1); `lib/antigravity.mjs` → `SERVICE_NAME`, `TASK_THREAD_PREFIX`, `buildTaskThreadName`, `buildPersistentTaskThreadName`; `antigravity-companion.mjs` → локальний дубль `MODEL_ALIASES`/`normalizeRequestedModel` (перейти на `resolveModelAlias` з lib), невикористаний `REVIEW_KIND` у `buildAdversarialReviewPrompt`; `session-lifecycle-hook.mjs` → дубль `SESSION_ID_ENV` (імпортувати з `tracked-jobs.mjs`).
- **C4 NOTICE**: root і plugin NOTICE зробити однаковими (Apache-2.0 практика): власний копірайт + рядок атрибуції upstream («This product includes software developed by OpenAI as part of codex-plugin-cc»).
- **C5 typos**: «a Antigravity» → «an Antigravity» у `commands/review.md:2,8`, `commands/adversarial-review.md:2`.
- **C6 plugin.json метадані**: додати `homepage`, `repository` (github.com/kozaksv/antigravity-plugin-cc), `license: "Apache-2.0"`, `keywords`.
- **C7 CHANGELOG + bump**: запис 1.0.2 (quota-фікс 53e6e5f, що не потрапив у 1.0.1, + всі зміни цієї фічі); наприкінці `npm run bump-version 1.0.2` (синхронізує package.json, lock, plugin.json, marketplace.json) + `npm run check-version`.

## 4. Edge-cases

- **A2**: `--sandbox` може заблокувати self-collect git-інспекцію в якійсь версії agy → escape env + fallback-гілка (sandbox лише для inline-diff). Рішення — ручний проб з реальним agy.
- **B1**: модель без суфікс-патерну (`(Thinking)`, кастомний label) — не мовчати, а помилка. Аліас має резолвитись у label ДО підстановки суфікса.
- **B2**: `stop_hook_active` відсутній/не-true → нормальний шлях; таймаути мають лишатись строго впорядкованими (780<840<900), інакше зовнішній kill знову випередить внутрішній BLOCK.
- **B4**: ні `XDG_STATE_HOME`, ні `HOME` → визначити поведінку (напр. помилка чи локальний фолбек); тест через тимчасові HOME/XDG.
- **B5**: stale-lock (мертвий писар лишив `state.lock`) — reclaim по mtime>10s + мертвий pid усередині.
- **B6**: >200 untracked — обрізання «…and N more»; 0 untracked — гілка не ламається.
- **C8**: trailing-бекслеш у кінці аргументу; подвійний бекслеш; `\"` всередині лапок.
- **C9**: `--timeout-ms 0` = миттєвий снапшот; від'ємні/NaN — існуюча валідація.
- **C1**: `mkdtemp` cleanup після проби; проба не має лишати сміття.

## 5. Ризики

- **A2 (найбільший)**: `--sandbox` реально ламає self-collect → потрібен fallback-план і ручний проб ПЕРЕД релізом. Мітигація: escape env + fallback-гілка вже закладені.
- **B5 локи**: неправильний stale-reclaim → або deadlock (лок ніколи не звільняється), або втрата захисту. Ще один клас — самодедлок від вкладеного лока (`updateState`→`saveState`): усунуто розділенням на залоканий вхід + приватний `saveStateUnlocked`. Мітигація: точна копія перевіреного job-slots патерну + атомарний write-and-rename + стрес-тест 15-20 паралельних писарів.
- **B7 shell на win32**: зайве прибирання `shell` зламало б `.cmd`/`.bat`-резолв (git/npm) → ENOENT на win32. Мітигація: лишаємо `shell:true` на win32 (cmd.exe), прибираємо лише небезпечний `process.env.SHELL`-оверрайд; `.cmd`-фолбек для `binaryAvailable`; наявні тести не деградують.
- **B1 effort**: звуження допустимих значень — breaking для тих, хто передавав інші рядки. Прийнятно (був no-op), але відзначити в CHANGELOG.
- **bump-version**: розсинхрон 4 файлів версії → `check-version` як гейт наприкінці.

## 6. Верифікація

- `cd <root> && npm test` — 74 наявні + новий юніт/argv-тест на КОЖЕН пункт (fake-agy fixture: `--sandbox` присутній/відсутній, effort→model label, схема в промпті `agy -p`, cwd auth-проби ≠ workspace, порожній spawn при `stop_hook_active`).
- `find plugins scripts tests -name '*.mjs' -print0 | xargs -0 -n 1 node --check`.
- `npm run check-version` після bump.
- Ручний пост-мердж проб реального agy: `--sandbox` + self-collect ревью (рішення по A2-fallback).

## 7. Поза скоупом (non-goals)

- Нові можливості agy (`--add-dir`, мультируту).
- Міграція старого /tmp-стану (job-и короткоживучі).
- Повна Windows CI-матриця (лише прибирання `process.env.SHELL`-оверрайду зі збереженням `shell:true` на win32 + `.cmd`-фолбек).
- Зміна session-scoped моделі job-ів (лише чесні доки — C2).
- Будь-які нові фічі поза списком знахідок.
