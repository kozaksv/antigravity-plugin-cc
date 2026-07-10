# Design: hardening-реліз плагіна antigravity за підсумками повного ревью (2026-07-10)

## Контекст

Повне ревью плагіна (весь рантайм `plugins/antigravity/scripts/**`, хуки, команди, скіли, промпти, схема, доки; 74/74 тести зелені; офіційний `claude plugin validate` — PASS) знайшло 2 критичні проблеми, ~8 середніх і ~10 дрібних. Ця фіча закриває **всі** знахідки одним hardening-релізом (цільова версія 1.0.2). Кожна знахідка нижче перевірена по коду з точними file:line; рішення сформульовані як напрям — фаза специфікації може уточнити деталі, але НЕ обсяг.

Джерела правди про поведінку `agy` 1.0.10: `docs/agy-cli.md` (live probe). Ключові факти звідти: `--sandbox` існує («terminal restrictions»); `-p` бере промпт лише з argv; `--print-timeout` — advisory; RESOURCE_EXHAUSTED видно лише у `--log-file`.

## Мета

1. Adversarial-ревью стабільно повертає валідний структурований JSON.
2. Read-only запуски чесні: або реальна ізоляція (`--sandbox`), або чесна документація — без обіцянок, яких код не виконує.
3. Жоден рекламований прапорець не є no-op.
4. Stop-гейт не може зациклитись і спалити квоту.
5. Стан плагіна переживає перезавантаження і не читається іншими користувачами машини.
6. Дрібний борг (мертвий код, typos, атрибуція, метадані) — вичищений.

## Рішення по знахідках

### A. Критичні

**A1. Схема adversarial-ревью ніколи не передається моделі.**
Факти: `antigravity-companion.mjs:421` передає `outputSchema: readOutputSchema(REVIEW_SCHEMA)` у `runTurn`, але `runOneShot` (`lib/antigravity.mjs`) цю опцію повністю ігнорує; промпт `prompts/adversarial-review.md` каже «matching the provided schema», але схеми в шаблоні нема; top-level ключ `next_steps` у промпті не згаданий взагалі → модель вгадує форму; при промаху `validateReviewResultShape` (`lib/render.mjs:24-41`) віддає користувачу сирий JSON («unexpected review shape»).
Рішення: додати у `<structured_output_contract>` шаблону плейсхолдер `{{OUTPUT_SCHEMA}}`; `buildAdversarialReviewPrompt` інтерполює туди `JSON.stringify(схема, null, 2)` з `schemas/review-output.schema.json`. Мертвий параметр `outputSchema` у виклику `runTurn` прибрати.
Тести: юніт — згенерований промпт містить `next_steps`, enum `verdict`, всі required-поля finding; argv-тест через fake-agy — промпт, що реально йде в `agy -p`, містить схему.

**A2. «Read-only» нічим не забезпечений: усі запуски йдуть з `--dangerously-skip-permissions`, `--sandbox` не використовується.**
Факти: `runReview` жорстко ставить `skipPermissions: true`; `runOneShot` (`lib/antigravity.mjs:660-664`) зводить `sandbox: "read-only"` лише до обчислення skipPermissions; `buildAgyArgs` не знає про `--sandbox`, хоча `agy` його має (`docs/agy-cli.md:51,74`). README тричі обіцяє «read-only and will not perform any changes» (README.md:9,97,121). Prompt-injection у ревьюваному диффі = довільні команди headless-агента з повними правами.
Рішення: `buildAgyArgs` додає `--sandbox` для не-write запусків (review, adversarial-review, task без `--write`); escape hatch — env `ANTIGRAVITY_COMPANION_NO_SANDBOX=1` вимикає (на випадок, якщо `--sandbox` заблокує self-collect git-інспекцію в якійсь версії agy). README отримує розділ «Security posture»: чесно про `--dangerously-skip-permissions` (без нього headless виснe), що дає і чого НЕ дає `--sandbox`, і що write-задачі не ізольовані. Формулювання «will not perform any changes» замінити на чесне.
Fallback-гілка (якщо ручний проб з реальним agy покаже, що `--sandbox` ламає self-collect): вмикати `--sandbox` лише для inline-diff режиму, self-collect — без нього + явна каветка в README. Вибір гілки — за пробою на етапі імплементації; дефолт дизайну — sandbox всюди для не-write.
Тести (fake-agy argv): review → є `--sandbox` і `--dangerously-skip-permissions`; `task --write` → НЕМА `--sandbox`; з env-override → нема `--sandbox`.

### B. Середні

**B1. `--effort` — тихий no-op.**
Факти: парситься й валідується (`antigravity-companion.mjs:117-131,773`), рекламується у `commands/rescue.md`, `agents/antigravity-rescue.md`, `skills/antigravity-cli-runtime/SKILL.md`, кладеться в request — і не доходить до `agy` (`executeTaskRun` не передає, `buildAgyArgs` не має прапорця). В agy effort закодовано в назві моделі («Gemini 3.5 Flash (High)»).
Рішення: effort мапиться на суфікс моделі. Допустимі значення звузити до `low|medium|high` (інші → помилка з підказкою). Логіка: базова модель = задана (аліас або label) або дефолтна `Gemini 3.5 Flash`; суфікс `(Low|Medium|High)` замінюється відповідно до effort; якщо label моделі не має такого суфікс-патерну (напр. `Claude Sonnet 4.6 (Thinking)`) — чітка помилка «effort не застосовний до цієї моделі». Оновити всі три доки (значення, приклади).
Тести: юніт-мапінг (з моделлю/без/аліас/несумісна модель); argv-тест: `task --effort high` → `--model "Gemini 3.5 Flash (High)"`.

**B2. Stop-гейт: нема захисту від зациклення + таймаут-гонка трьох рівних таймерів.**
Факти: `stop-review-gate-hook.mjs` не читає `stop_hook_active` із вхідного JSON (канонічний запобіжник Claude Code); при вичерпаній квоті гейт BLOCK-ає, Claude не може «полагодити» квоту, знову стоп → знову 15-хв ран → нескінченний цикл. Три таймери рівні 15 хв: `hooks.json` Stop `timeout: 900` = `STOP_REVIEW_TIMEOUT_MS` = `DEFAULT_TURN_TIMEOUT_MS` → зовнішній kill випереджає внутрішній «timed out»-BLOCK, стоп мовчки проходить.
Рішення: (а) `input.stop_hook_active === true` → logNote + return (allow), жодного повторного ревью в одному stop-циклі; (б) каскад таймаутів: agy-turn 780s (hook передає ліміт у task; механізм — env `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS`, який `runOneShot` читає як fallback до `options.timeoutMs`) < spawnSync 840s < hook 900s.
Тести: hook із `stop_hook_active: true` → task не спавниться (argv-лог fake-agy порожній), стоп дозволений; юніт на env-fallback таймаута.

**B3. SessionEnd-хук не вкладається у власний таймаут 5s.**
Факти: `hooks.json:21` — 5s; `cleanupSessionJobs` (`session-lifecycle-hook.mjs:33-85`) на кожну живу задачу: SIGTERM → синхронний grace до 5s → SIGKILL для ДВОХ pid (agyPid + wrapper) + git-відкат (`reset --hard` + `stash apply`).
Рішення: `hooks.json` SessionEnd timeout → 60; у teardown-шляху передавати `terminateProcessTree(pid, { graceMs: 2000 })`.
Тести: наявний session-lifecycle тест + юніт, що cleanup передає зменшений grace.

**B4. Стан у `/tmp` за замовчуванням: втрата після ребута/очистки, 0755/0644 на multi-user машині.**
Факти: `state.mjs:29-44` — `CLAUDE_PLUGIN_DATA` (яку Claude Code сам не виставляє) або `os.tmpdir()/antigravity-companion`. Там лежать промпти, результати і конфіг `stopReviewGate`.
Рішення: ланцюг `CLAUDE_PLUGIN_DATA` → `XDG_STATE_HOME/antigravity-companion` → `~/.local/state/antigravity-companion`; `mkdirSync` з `mode: 0o700`. Міграції старого /tmp-стану НЕ робити (job-и короткоживучі) — зафіксувати в CHANGELOG.
Тести: юніт на ланцюг фолбеків і mode (через тимчасовий HOME/XDG_STATE_HOME).

**B5. `state.json` — read-modify-write без локів.**
Факти: `updateState` (`state.mjs:118-122`) без серіалізації; конкурентні писарі: background-worker (progress/фінал), `/antigravity:cancel`, session-хук → загублені оновлення. Слоти (`job-slots.mjs`) покривають лише конкуренцію agy-процесів background-задач.
Рішення: lock-файл `state.lock` за тим самим O_EXCL-патерном, що job-slots (retry ~50ms, загальний ліміт ~5s, stale-reclaim: mtime старший 10s + мертвий pid усередині), обгорнути весь `updateState`/`saveState`.
Тести: стрес — 15-20 паралельних процесів, кожен `upsertJob` свого id → у фіналі присутні ВСІ записи (без лока тест ловить втрати).

**B6. Self-collect режим інлайнить повні тіла untracked-файлів.**
Факти: `git.mjs:246-255` — гілка `includeDiff === false` («lightweight summary») однаково вкладає тіла всіх untracked до 24КБ кожен без ліміту кількості → переповнення `MAX_PROMPT_BYTES` саме там, де його мали уникнути.
Рішення: у self-collect гілці — лише список імен + розмірів (перші ~200, далі «…and N more»), без тіл.
Тести: юніт `collectReviewContext` з кількома untracked → self-collect контент без тіл, з іменами.

**B7. Windows: `shell: true` з argv-масивом = ін'єкція/квотинг.**
Факти: `process.mjs:12` — `shell: process.env.SHELL || true` на win32; Node не екранує args при shell:true; юзерський `--base <ref>` іде в git через shell.
Рішення: прибрати shell повністю (git/taskkill/node/agy його не потребують); для `binaryAvailable` на win32 — фолбек-проба `<cmd>.cmd` (npm.cmd), щоб setup-перевірка npm не зламалась.
Тести: юніт binaryAvailable з DI (проба .cmd-фолбека), решта — наявні тести не деградують.

**B8. Foreground-ревью вбиває дефолтний 2-хв таймаут Bash-tool.**
Факти: `commands/review.md`/`adversarial-review.md` foreground-флоу не задають timeout; дефолт Claude Code — 120s; типове ревью довше.
Рішення: у foreground-блоках обох команд явно інструктувати `timeout: 600000` для Bash-виклику; те саме правило — у `agents/antigravity-rescue.md` для foreground task.

### C. Дрібні (всі в обсязі)

**C1. Auth-probe засмічує resume-шлях**: `getAntigravityAuthStatus` ганяє «Reply with exactly: OK» у cwd користувача → перетирає `last_conversations.json[cwd]` → наступний `--resume-last` втрачає швидкий `-c` і йде повільним `--conversation <id>`. Рішення: проб виконувати з одноразового tmp-каталогу (`mkdtemp`), не з workspace. Тест: argv/cwd-лог fake-agy — cwd проби ≠ workspace.

**C2. Кросс-сесійний resume мертвий, а доки/коментарі стверджують протилежне**: SessionEnd видаляє job-и сесії; session-фільтр відсікає чуже; `findLatestTaskThread` → завжди null; коментар `lib/antigravity.mjs:811-817` і README-фраза «continue the latest rescue thread for this repo» брешуть. Рішення: поведінку НЕ міняти (session-scoped — свідомий дизайн), виправити коментар, README («в межах поточної сесії»), і згадки в rescue.md/skill за потреби.

**C3. Мертвий код — видалити**: `fs.mjs` → `ensureAbsolutePath`, `safeReadFile` (`createTempDir` ЛИШАЄТЬСЯ — вживається в C1); `lib/antigravity.mjs` → `SERVICE_NAME`, `TASK_THREAD_PREFIX`, `buildTaskThreadName`, `buildPersistentTaskThreadName`; `antigravity-companion.mjs` → локальний дубль `MODEL_ALIASES`/`normalizeRequestedModel` (використати `resolveModelAlias` з lib), невикористаний `REVIEW_KIND` у `buildAdversarialReviewPrompt`; `session-lifecycle-hook.mjs:11` → дубль `SESSION_ID_ENV` (імпортувати з `tracked-jobs.mjs`).

**C4. NOTICE неконсистентний**: root — «Copyright 2026 OpenAI», plugin — «Copyright 2026 Sergii Kozak»; репо — дериват openai/codex-plugin-cc (remote upstream). Рішення: обидва файли однакові, за Apache-2.0 практикою: власний копірайт + рядок атрибуції upstream («This product includes software developed by OpenAI as part of codex-plugin-cc»).

**C5. Typos**: «a Antigravity» → «an Antigravity» у `commands/review.md:2,8` і `commands/adversarial-review.md:2` (description видно в меню команд).

**C6. `plugin.json` метадані**: додати `homepage`, `repository` (github.com/kozaksv/antigravity-plugin-cc), `license: "Apache-2.0"`, `keywords`.

**C7. CHANGELOG 1.0.2**: запис про quota-фікс (53e6e5f, не потрапив у 1.0.1) + всі зміни цієї фічі; `npm run bump-version 1.0.2` наприкінці (синхронізує package.json, lock, plugin.json, marketplace.json — перевіряється `npm run check-version`).

**C8. `splitRawArgumentString` з'їдає бекслеші** (`lib/args.mjs:89-91`): `C:\path` → `C:path`. Рішення: бекслеш екранує лише наступні пробіл/лапку/бекслеш; перед іншими символами — literal. Тест: `C:\Users\x` виживає, `\"` досі екранує.

**C9. `--timeout-ms 0` неможливий** (`antigravity-companion.mjs:317` — `|| DEFAULT` на falsy 0). Рішення: `Number.isFinite` перевірка; 0 = миттєвий снапшот без очікування. Юніт.

## Верифікація

- Повний `npm test` (74 наявні + нові юніти на КОЖЕН пункт вище; fake-agy fixture розширити argv-перевірками: `--sandbox`, effort→model, схема в промпті, cwd auth-проби, відсутність spawn-у при `stop_hook_active`).
- `node --check` для всіх `.mjs`.
- `npm run check-version` після bump-у.
- Ручний пост-мердж проб із реальним agy: `--sandbox` + self-collect ревью (рішення по A2-fallback).

## Non-goals

- Нові можливості agy (`--add-dir`, мультируту).
- Міграція старого /tmp-стану.
- Повна Windows CI-матриця (лише прибирання shell:true + .cmd-фолбек).
- Зміна session-scoped моделі job-ів (лише чесні доки, C2).
