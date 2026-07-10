# План реалізації: hardening-реліз плагіна antigravity (review-fixes → 1.0.2)

Дата: 2026-07-10
Спека: `docs/superpowers/specs/2026-07-10-review-fixes.md`
Дизайн: `docs/superpowers/specs/2026-07-10-review-fixes-design.md`
Гілка: `feat/review-fixes`
Скоуп: `plugins/antigravity/**` + доки в корені. Монорепо нема, єдиний npm-пакет.

## Загальні правила для кожного субагента

- РОБОЧИЙ КОРІНЬ: `/Users/a/Library/CloudStorage/Dropbox/AI/antigravity-plugin-cc--review-fixes`. Твій shell cwd може бути ІНШИМ worktree.
- Усі git-команди: `git -C "/Users/a/Library/CloudStorage/Dropbox/AI/antigravity-plugin-cc--review-fixes" …` (НІКОЛИ голий `git`).
- Read/Edit/Write і файлові Bash — ЛИШЕ абсолютні шляхи під коренем. Ніколи відносний шлях.
- Тести/build/bump: `cd "/Users/a/Library/CloudStorage/Dropbox/AI/antigravity-plugin-cc--review-fixes" && npm test` (ізольована БД авто з `.env.test`).
- Syntax-gate після зміни `.mjs`: `cd "<root>" && find plugins scripts tests -name '*.mjs' -print0 | xargs -0 -n 1 node --check`.
- Перед КОЖНИМ комітом: `git -C "<root>" status --short` МАЄ показувати саме твої файли. Порожньо/не ті → писав не туди, виправ шлях.
- TDD-цикл на кожну задачу: (1) написати падаючий тест, (2) запустити — переконатись, що падає з очікуваної причини, (3) імплементувати, (4) `npm test` зелений, (5) syntax-gate, (6) verify-крок задачі.
- Порядок фаз: критичні (A1, A2) → середні (B*) → дрібні (C*) → реліз (R1). Ключові файли (`state.mjs`, `antigravity.mjs`, `git.mjs`, `process.mjs`) чіпають кілька задач — виконувати послідовно в межах свого файлу, щоб уникнути конфліктів; задачі різних файлів незалежні.

Тестові файли (наявні): `tests/state.test.mjs`, `runtime.test.mjs`, `git.test.mjs`, `process.test.mjs`, `commands.test.mjs`, `session-lifecycle.test.mjs`, `stop-review-gate.test.mjs`, `render.test.mjs`, `bump-version.test.mjs`, `job-slots.test.mjs`. Fixture: `tests/fake-agy-fixture.mjs`, helpers: `tests/helpers.mjs`. Базлайн: 74 тести зелені.

Референс O_EXCL-локу (реюзати, не копіювати логіку): `plugins/antigravity/scripts/lib/job-slots.mjs` — атомарний `openSync(...,"wx")` + PID у payload при створенні (`job-slots.mjs:207-219`), reap по mtime+dead-pid (`job-slots.mjs:90-142`).

---

## ФАЗА A — КРИТИЧНІ

### A1. Схема в промпт + runtime JSON-Schema валідація (fail-closed) + bounded repair

Файли: `plugins/antigravity/prompts/adversarial-review.md` (блок `<structured_output_contract>`), `plugins/antigravity/scripts/lib/prompts.mjs` (`buildAdversarialReviewPrompt`), `plugins/antigravity/scripts/lib/antigravity.mjs` (`parseStructuredOutput` — `antigravity.mjs:829`; виклик `runTurn` з мертвим `outputSchema` — знайти grep `outputSchema`), `plugins/antigravity/schemas/review-output.schema.json`, `plugins/antigravity/scripts/antigravity-companion.mjs` (`buildAdversarialReviewPrompt` виклик, `REVIEW_KIND:` — `antigravity-companion.mjs:246`).

Зробити:
1. У `prompts/adversarial-review.md`, блок `<structured_output_contract>`, додати плейсхолдер `{{OUTPUT_SCHEMA}}`.
2. `buildAdversarialReviewPrompt` інтерполює `JSON.stringify(schema, null, 2)` зі `schemas/review-output.schema.json` (включно з top-level `next_steps`).
3. Прибрати мертвий `outputSchema: readOutputSchema(REVIEW_SCHEMA)` з виклику `runTurn` (`runOneShot` його ігнорує — grep `outputSchema` в `antigravity.mjs`).
4. Додати легкий JSON-Schema валідатор БЕЗ мережевих залежностей (новий `lib/schema-validate.mjs` або inline-функція): підтримка `type`, `enum`, `required`, `additionalProperties:false`, `minLength`, `items`, вкладені `properties`. Валідувати розпарсений output проти `review-output.schema.json`.
5. `parseStructuredOutput`/пост-обробка ревью: fail-closed — невалідний output (невірні `verdict`/`severity`/`confidence`, зайві поля, неповні `findings`) → **помилка ревью**, не «успіх».
6. Bounded repair: при провалі валідації — щонайбільше **один** repair-turn (передати agy назад список помилок валідатора з вимогою повернути валідний JSON). Якщо повторно невалідний → явна помилка. Ліміт жорсткий (не зациклювати turn-бюджет).

Тести (`tests/runtime.test.mjs` + новий `tests/schema-validate.test.mjs`):
- Валідатор: валідний зразок проходить; кожен клас невалідності падає — `verdict` поза enum, `severity`/`confidence` невірні, зайве top-level поле (`additionalProperties`), `findings[]` без обов'язкового поля, відсутній top-level `next_steps`.
- Промпт містить серіалізовану схему (перевірити, що `{{OUTPUT_SCHEMA}}` замінено і присутнє `"verdict"`/`"next_steps"`).
- fail-closed інтеграція (fake-agy повертає невалідний JSON): результат = помилка, не success.
- repair: fake-agy повертає невалідний → валідний на 2-й turn → success; невалідний двічі → явна помилка, рівно один repair-turn (лічильник викликів fake-agy).

Verify: `npm test` зелений; grep `outputSchema` в `antigravity.mjs` не показує мертвого поля; ручний прогін `node antigravity-companion.mjs adversarial-review …` (за наявності agy) друкує схему в промпт-дампі.

### A2. Sandbox для не-write запусків + canary-чекліст

Файли: `plugins/antigravity/scripts/lib/antigravity.mjs` (`buildAgyArgs` — `antigravity.mjs:321-358`), `plugins/antigravity/scripts/antigravity-companion.mjs` (передача прапорця sandbox в options для review/adversarial-review/task-без-write).

Зробити:
1. `buildAgyArgs` додає `--sandbox` для не-write запусків (review, adversarial-review, `task` без `--write`); НЕ додає для `task --write`. Прапорець контролюється `options.sandbox` (виставляється викликами в companion за режимом).
2. Escape hatch: env `ANTIGRAVITY_COMPANION_NO_SANDBOX=1` вимикає `--sandbox` (валідований парсинг: `=== "1"`).
3. `--dangerously-skip-permissions` (`antigravity.mjs:346-347`) ЛИШАЄТЬСЯ (без нього headless-agy висне) — задокументувати чесно (див. A2-доки, окрема задача).
4. Джерело правди поведінки agy — `docs/agy-cli.md`: `--sandbox` існує.

Тести (`tests/runtime.test.mjs`, argv-перевірки через `buildAgyArgs`/fake-agy fixture):
- review/adversarial-review argv містить `--sandbox`.
- `task --write` argv НЕ містить `--sandbox`.
- `ANTIGRAVITY_COMPANION_NO_SANDBOX=1` → `--sandbox` відсутній навіть для review.
- self-collect (`includeDiff===false`) review під sandbox все ще будує коректний argv (доступність git-інспекції — canary нижче).

Canary (ручний пост-мердж, зафіксувати у README «Security posture» — задача A2-доки): під `--sandbox` спробувати write у (1) tracked, (2) untracked, (3) поза workspace, (4) symlink-escape — КОЖЕН має бути ЗАБЛОКОВАНИЙ; окремо self-collect git-інспекція має ПРАЦЮВАТИ. Якщо хоч один write проходить → `--sandbox` не boundary: README не обіцяє read-only, переглянути A2-гілку (sandbox всюди vs лише inline-diff). Дефолт дизайну: sandbox для всіх не-write.

Verify: `npm test` зелений; argv-тести доводять присутність/відсутність `--sandbox`; canary-чекліст записаний у README (пост-мердж проб окремо).

---

## ФАЗА B — СЕРЕДНІ

### B1. Effort → суфікс назви моделі

Файли: `plugins/antigravity/scripts/antigravity-companion.mjs` (`normalizeReasoningEffort` — `antigravity-companion.mjs:117-128`, `buildTaskRequest` — `:629`, передача `effort` — `:773,795,813`), `plugins/antigravity/scripts/lib/antigravity.mjs` (`resolveModelAlias` — `antigravity.mjs:86-94`, `buildAgyArgs` model — `:336-339`, `MODEL_ALIASES` — `:74`).

Зробити:
1. Звузити допустимі effort до `low|medium|high` (інше → помилка з підказкою). Наразі `normalizeReasoningEffort` приймає `none|minimal|low|medium|high|xhigh` і це **no-op** (effort ніде не доходить до agy — grep `effort` в `antigravity.mjs` порожній). Це breaking — відзначити в CHANGELOG.
2. Базова модель = задана (аліас/label через `resolveModelAlias`) або дефолт `Gemini 3.5 Flash`.
3. Суфікс `(Low|Medium|High)` підставляється/замінюється за effort ПІСЛЯ резолву аліаса в label. Прапорець доходить до agy як `--model "<label> (High)"`.
4. Якщо label не має суфікс-патерну `(...)`, який можна замінити на effort-рівень (напр. `Claude Sonnet 4.6 (Thinking)`) → чітка помилка «effort не застосовний до цієї моделі». Аліас має резолвитись у label ДО підстановки суфікса.
5. Реалізувати мапінг як окрему функцію (напр. `applyEffortToModel(label, effort)` в `lib/antigravity.mjs`), реюзну з argv-збірки.

Тести (`tests/runtime.test.mjs`):
- `effort=high` + дефолтна модель → `--model "Gemini 3.5 Flash (High)"`.
- `effort=low` замінює наявний суфікс (модель з `(Medium)` → `(Low)`).
- effort поза `low|medium|high` → помилка з підказкою.
- модель з несумісним суфіксом (`(Thinking)`) + effort → помилка «не застосовний».
- аліас `spark` резолвиться в label ДО суфікса.

Verify: `npm test` зелений; argv доводить `(High)` у `--model`.

### B2. Каскад таймаутів + `stop_hook_active` + env-читалка в runOneShot

Файли: `plugins/antigravity/scripts/stop-review-gate-hook.mjs` (`STOP_REVIEW_TIMEOUT_MS` — `stop-review-gate-hook.mjs:16`, spawnSync timeout — `:132`, `input.stop_hook_active`), `plugins/antigravity/scripts/lib/antigravity.mjs` (`runOneShot` — `antigravity.mjs:618`; inner timer — `:449-462`; `DEFAULT_TURN_TIMEOUT_MS` — `:41`), `plugins/antigravity/hooks/hooks.json` (Stop timeout 900 — `hooks.json:32`).

Зробити:
1. **Хук `stop_hook_active`**: на вході читати `input.stop_hook_active === true` → `logNote` + allow (жодного повторного ревью в тому ж stop-циклі).
2. **Каскад 780 < 840 < 900**: inner agy-turn 780s < spawnSync 840s < hook 900s.
   - `hooks.json` Stop timeout лишається 900.
   - `stop-review-gate-hook.mjs` spawnSync timeout (`STOP_REVIEW_TIMEOUT_MS`) → 840s.
   - Хук передає inner-ліміт у task через env `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS = 780000` (у `childEnv`).
3. **Env-читалка в `runOneShot` (ЗАРАЗ ВІДСУТНЯ — додати)**: `runOneShot`/inner timer читає `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS` як fallback до `options.timeoutMs`. Валідований парсинг: `Number.isFinite` && `>0`, інакше ігнор із `logNote`. Ліміт застосовується до **внутрішнього** agy-turn timer (`antigravity.mjs:449`). Без цього inner timer лишиться 900s і spawnSync уб'є wrapper раніше за внутрішній BLOCK — гонка повернеться.
4. Пріоритет: `options.timeoutMs` (явний) > env > `DEFAULT_TURN_TIMEOUT_MS`.

Тести (`tests/stop-review-gate.test.mjs` + `tests/runtime.test.mjs`, kill-order інтеграційний з fake-agy що спить довше за всі ліміти):
- `stop_hook_active===true` → allow без spawnSync (лічильник spawn = 0).
- runOneShot без env → `DEFAULT_TURN_TIMEOUT_MS`; з валідним env → env перекриває inner timer; NaN/≤0 → ігнор + logNote.
- kill-order: внутрішній 780 спрацьовує РАНІШЕ за spawnSync 840 і hook 900 (fake-agy sleep, перевірити що перший kill — від inner timer). Використати малі масштабовані значення (напр. 780/840/900 ms) для швидкості тесту, зберігаючи порядок.

Verify: `npm test` зелений; kill-order тест доводить фактичний порядок; `hooks.json` Stop = 900.

### B3. SessionEnd teardown — прибрати руйнівний rollback + timeout 5→60 + recoverable

Файли: `plugins/antigravity/scripts/session-lifecycle-hook.mjs` (`restoreWorkspaceSnapshot` виклик — `session-lifecycle-hook.mjs:74`, `terminateProcessTree(pid)` — `:63`, фінальний `saveState` — `:81`), `plugins/antigravity/scripts/lib/git.mjs` (`restoreWorkspaceSnapshot` — `git.mjs:350-393`, зокрема `git reset --hard` — `:370`), `plugins/antigravity/hooks/hooks.json` (SessionEnd timeout 5 — `hooks.json:21`).

Зробити:
1. `hooks.json` SessionEnd timeout 5 → 60.
2. Teardown: `terminateProcessTree(pid, { graceMs: 2000 })` (`session-lifecycle-hook.mjs:63`).
3. **Прибрати беззастережний `git reset --hard`** (`git.mjs:370`): якщо working tree розійшовся зі snapshot непередбачувано (невідомі post-snapshot зміни в tracked-файлах при незмінному HEAD) — teardown лишає tree як є і логує, НЕ робить `reset --hard`.
4. **Recoverable відкат**: поточний tree перед будь-яким відкатом зберігати `git stash create` → `git stash store` (або окремий unreachable-commit), щоб зміни завжди відновлювались через `git stash list`/reflog.
5. **Фінальний запис teardown через `updateState`** (read-modify-write під локом на СВІЖОМУ стані — залежить від B5): наново прочитати стан і відфільтрувати ЛИШЕ ті job id, які teardown реально прибрав, не переносячи весь застарілий snapshot (`session-lifecycle-hook.mjs:81` — замінити `saveState(старий snapshot)` на `updateState`). Snapshot до kill — тільки щоб знати кого вбивати.
6. Worktree-ізоляція write-задач — зафіксувати як напрям (не в цьому релізі).

Тести (`tests/session-lifecycle.test.mjs`, `tests/git.test.mjs`):
- post-snapshot tracked-edit користувача при незмінному HEAD → після teardown НЕ зникає; відкат recoverable (edit знаходиться в `git stash list`/reflog).
- HEAD змінився → `restored:false` з причиною (наявна поведінка збережена — `git.mjs:360`).
- фінальний запис teardown після конкурентного write не затирає свіжий стан (updateState на свіжому read; спарити з B5-тестом).

Verify: `npm test` зелений; grep `reset --hard` в `git.mjs` — беззастережного виклику нема (або обгорнутий recoverable-логікою); `hooks.json` SessionEnd = 60.

### B4. Директорія стану XDG + одноразова міграція з /tmp

Файли: `plugins/antigravity/scripts/lib/state.mjs` (`FALLBACK_STATE_ROOT_DIR` — `state.mjs:10`, `resolveStateDir` — `:29-44`, `ensureStateDir` — `:54`, `loadState` — `:58`).

Зробити:
1. Ланцюг директорії стану: `CLAUDE_PLUGIN_DATA/state` → `XDG_STATE_HOME/antigravity-companion` → `~/.local/state/antigravity-companion`. Прибрати `os.tmpdir()`-фолбек (`state.mjs:10,42`).
2. `mkdirSync` з `mode: 0o700` (`ensureStateDir` — `state.mjs:54-56`).
3. Edge: ні `XDG_STATE_HOME`, ні `HOME` → визначити поведінку (помилка або локальний фолбек; обрати й задокументувати в CHANGELOG).
4. **Одноразова міграція (обов'язкова)**: при першому `loadState` з новим шляхом, якщо новий `state.json` відсутній, а старий /tmp-шлях (`os.tmpdir()/antigravity-companion/<slug>-<hash>/state.json`) читабельний:
   - імпортувати щонайменше `config` **весь** (з `stopReviewGate`) і незавершені job handles (`running`/`queued`);
   - записати в новий стан **під локом** (залежить від B5 — `updateState`/`saveStateUnlocked`);
   - позначити старий файл мігрованим: перейменувати в `state.json.migrated` (ідемпотентність — не спрацьовувати двічі);
   - corrupt/нечитабельний старий стан → пропустити міграцію з `logNote`, НЕ падати.
5. Зафіксувати міграцію в CHANGELOG.

Тести (`tests/state.test.mjs`, через тимчасові `HOME`/`XDG_STATE_HOME`/`CLAUDE_PLUGIN_DATA`):
- resolveStateDir дає XDG-шлях, не /tmp.
- новий каталог створюється з `0o700`.
- міграція: старий /tmp-стан з `stopReviewGate=true` + running job → після першого `loadState` новий стан містить той самий config і job handle; старий файл → `.migrated`.
- ідемпотентність: повторний `loadState` не дублює.
- corrupt старий стан → skip + logNote, новий стан = default, без throw.
- edge XDG/HOME відсутні → обрана поведінка.

Verify: `npm test` зелений; grep `os.tmpdir` в `state.mjs` — прибрано (лишається лише в міграції як читалка старого шляху, якщо потрібно).

### B5. Блокування запису стану (state.lock + per-job) + fail-closed loadState + atomic write

Файли: `plugins/antigravity/scripts/lib/state.mjs` (`saveState` — `state.mjs:92-116`, `updateState` — `:118-122`, `writeJobFile` — `:166-171`, `loadState` — `:58-78`, `defaultState` — `:19`), реюз `plugins/antigravity/scripts/lib/job-slots.mjs` O_EXCL-хелпера.

Зробити:
1. **Виділити переюзний O_EXCL lock-хелпер** з патерну `job-slots.mjs` (`withFileLock(lockPath, fn)`): `openSync(lockPath,"wx")`, PID+timestamp payload пишеться **атомарно в момент створення** (у той самий `openSync`→`writeSync`→`closeSync` до того, як інший процес прочитає), retry ~50ms до ~5s, stale-reclaim по mtime>10s + dead-pid. Помістити в `lib/job-slots.mjs` (експорт) або новий `lib/file-lock.mjs`. НЕ власна копія — реюзати перевірену деталь.
2. **`state.lock`** береться ЛИШЕ на write-точках входу і **без вкладення** (O_EXCL нереентрантний):
   - приватний `saveStateUnlocked` (без власного лока) — тіло запису;
   - `updateState` = read→mutate→write повністю під ОДНИМ локом, викликає всередині `saveStateUnlocked`;
   - публічний `saveState` бере той самий лок ОДИН раз навколо свого write.
   - Лок ніколи не вкладається сам у себе.
3. **Atomic write-and-rename** для `state.json`: серіалізувати в `state.json.<pid>.tmp` у тій самій директорії → `fs.renameSync` поверх цільового. Прибрати прямий `fs.writeFileSync` у цільовий (`state.mjs:114`).
4. **`loadState` fail-closed** (`state.mjs:58-78`): default дозволено ЛИШЕ для `ENOENT`. Будь-яка інша помилка (`JSON.parse` corrupt, EIO, EACCES, EMFILE) → **кидається/пробрасується** (не повертає `defaultState()`). Виклики, що читають для мутації, при не-ENOENT помилці **abort-ять write** (лишають файл як є) з `logNote`. Прибрати `catch { return defaultState(); }` (`state.mjs:75-77`).
5. **Per-job файли `jobs/<id>.json`** (`writeJobFile` — `state.mjs:166-171`): кожен запис — atomic write-and-rename під **per-job локом** (`jobs/<id>.lock`, той самий хелпер), і переходи статусу — **CAS/монотонні**: `cancelled`/`completed`/`failed` термінальні; термінальний не перезаписується не-термінальним; `completed` не затирає `cancelled`. (Альтернатива, якщо простіше: `state.json` — єдиний canonical source для статусів, `jobs/<id>.json` — похідний append-only; вибір гілки на етапі імплементації — вимога: усунути незалочений read-modify-write per-job.)
6. Формат `state.json` (jobs[]) НЕ змінюється — лише механіка доступу.

Тести (`tests/state.test.mjs` — stress + fail-closed):
- 15-20 паралельних писарів `state.json` (spawn воркерів) → без обрізаних/втрачених записів, фінальний JSON парситься.
- 15-20 паралельних писарів `jobs/<id>.json` → без обрізаних; термінальний→не-термінальний перехід НЕ відбувається.
- `updateState`→`saveStateUnlocked` не самодедлочиться (не EEXIST на власному локові).
- `loadState` при corrupt JSON / EACCES / EIO → **кидає**, НЕ повертає default; наступний write abort-нутий, файл на диску не змінився.
- `loadState` при ENOENT → default (наявна поведінка).
- stale-lock (мертвий pid у lock-файлі, mtime>10s) → reclaim; свіжий лок з живим pid → не reclaim.
- PID пишеться атомарно (порожній lock-файл у grace-вікні не reclaim-иться передчасно).

Verify: `npm test` зелений; stress-тест стабільний (прогнати 3×); grep `return defaultState()` в `loadState` catch — прибрано; grep прямого `writeFileSync(resolveStateFile` — прибрано (замінено atomic rename).

### B6. self-collect untracked — лише імена+розміри

Файли: `plugins/antigravity/scripts/lib/git.mjs` (гілка `includeDiff===false` — `git.mjs:246-260`, `formatUntrackedFile` — grep, `collectWorkingTreeContext`/`collectBranchContext`).

Зробити: у гілці `includeDiff === false` інлайнити лише список імен+розмірів untracked (перші ~200, далі `…and N more`), без тіл файлів. (У гілці `includeDiff === true` — без змін, тіла лишаються.)

Тести (`tests/git.test.mjs`):
- self-collect (`includeDiff:false`) з untracked → вивід містить імена+розміри, НЕ тіла.
- >200 untracked → `…and N more`.
- 0 untracked → гілка не ламається (порожній список).
- inline-diff (`includeDiff:true`) untracked-тіла лишаються (регрес-контроль).

Verify: `npm test` зелений.

### B7. Windows shell — `shell:false` + PATHEXT/where.exe резолв (command injection)

Файли: `plugins/antigravity/scripts/lib/process.mjs` (`runCommand` shell — `process.mjs:12`, `binaryAvailable` — `:38`).

Зробити:
1. **`shell:false` для ВСІХ Git/native-спавнів** на всіх ОС (argv лишається межею). Прибрати `shell: process.platform === "win32" ? (process.env.SHELL || true) : false` (`process.mjs:12`) — і небезпечний `process.env.SHELL || true`, і `shell:true`.
2. Проблему `.cmd`/`.bat` (git/npm/agy у PATH як `.cmd` → `spawnSync` з `shell:false` дасть ENOENT) розв'язати **явним резолвом розширення**, НЕ shell-ом: на win32 резолвити повний шлях бінарника через `PATHEXT` (перебір `.exe`/`.cmd`/`.bat`/`.com`) або `where.exe`; спавнити **резолвлений шлях** з `shell:false`. Аргументи (включно з user-controlled `--base <ref>`) ніколи не проходять через інтерпретатор.
3. `binaryAvailable` на win32 (`process.mjs:38`) — резолв через той самий PATHEXT/`where.exe`-механізм (напр. знайти `npm.cmd`), без shell.
4. Винести резолвер у хелпер (напр. `resolveExecutable(command)` в `process.mjs`); на POSIX — no-op (повертає command).

Тести (`tests/process.test.mjs`):
- POSIX: `runCommand` спавнить з `shell:false` (мок spawnSync, перевірити options).
- injection: `--base` з `& | > ^` не виконує другу команду (argv-межа збережена) — на POSIX прямий тест, на win32 через мок-резолв.
- win32 (мок platform): резолв `git`/`npm` через PATHEXT/`where.exe` знаходить `.cmd` без ENOENT і без shell.
- `binaryAvailable` win32 знаходить `npm.cmd`.

Verify: `npm test` зелений; grep `shell:` в `process.mjs` — лише `false` (або відсутнє); grep `process.env.SHELL` — прибрано.

---

## ФАЗА C — ДРІБНІ

### C1. auth-probe cwd — mkdtemp замість workspace

Файли: `plugins/antigravity/scripts/lib/antigravity.mjs` (`getAntigravityAuthStatus` — `antigravity.mjs:544-564`), `plugins/antigravity/scripts/lib/fs.mjs` (`createTempDir` — `fs.mjs:9`, ЛИШАЄТЬСЯ).

Зробити: `getAntigravityAuthStatus` виконувати з одноразового `mkdtemp`-каталогу (`createTempDir`), не з workspace cwd — щоб не перетирати `last_conversations.json[cwd]` і не ламати `--resume-last`. Cleanup mkdtemp після проби.

Тести (`tests/runtime.test.mjs`):
- probe спавниться з cwd ≠ workspace (мок runOneShot/spawn, перевірити cwd — temp).
- temp-каталог прибирається після (не лишає сміття).

Verify: `npm test` зелений.

### C2. Чесні доки resume (поведінку НЕ міняти)

Файли: `plugins/antigravity/scripts/lib/antigravity.mjs` (коментар ~`antigravity.mjs:811-817`), `README.md` (фраза «continue the latest rescue thread for this repo»), `plugins/antigravity/commands/rescue.md`, `plugins/antigravity/skills/antigravity-cli-runtime/SKILL.md` (за потреби).

Зробити: поведінка session-scoped — свідомий дизайн, НЕ міняти. Виправити брехливий коментар (`antigravity.mjs:811-817`) і README-фразу → «в межах поточної сесії». Оновити згадки в rescue.md/skill за потреби.

Тести: доковий текст — grep-перевірка в `tests/commands.test.mjs` за наявності відповідних asserts (інакше — ручна перевірка). Мінімум: `find … node --check` не потрібен для .md.

Verify: grep «continue the latest rescue thread» у README/коментарях — прибрано/переформульовано.

### C3. Мертвий код (видалити)

Файли/символи:
- `plugins/antigravity/scripts/lib/fs.mjs`: прибрати `ensureAbsolutePath` (`fs.mjs:5`), `safeReadFile` (`fs.mjs:21`). **`createTempDir` (`fs.mjs:9`) ЛИШАЄТЬСЯ** (потрібен C1).
- `plugins/antigravity/scripts/lib/antigravity.mjs`: `SERVICE_NAME` (`:31`), `TASK_THREAD_PREFIX` (`:32`), `buildTaskThreadName` (`:175`), `buildPersistentTaskThreadName` (`:819`), і export-рядок (`:860`).
- `plugins/antigravity/scripts/antigravity-companion.mjs`: локальний дубль `MODEL_ALIASES` (`:76`)/`normalizeRequestedModel` (`:106-114`) → перейти на `resolveModelAlias` з lib; невикористаний `REVIEW_KIND` (`:246`).
- `plugins/antigravity/scripts/session-lifecycle-hook.mjs`: дубль `SESSION_ID_ENV` (`:11`) → імпортувати з `tracked-jobs.mjs`.

Зробити: видалити символи, перевести companion на `resolveModelAlias` (узгодити з B1, який теж чіпає модель-резолв — виконувати ПІСЛЯ B1 або спільно), імпортувати `SESSION_ID_ENV` з `tracked-jobs.mjs`.

Тести: наявні тести мають лишатись зеленими (нема регресу від видалення). Якщо якийсь тест імпортував видалений символ — оновити.

Verify: `npm test` зелений; syntax-gate; grep кожного видаленого символа — 0 використань (крім C1-`createTempDir`).

### C4. NOTICE — вирівняти root і plugin

Файли: `NOTICE` (root), `plugins/antigravity/NOTICE` (якщо є; інакше створити консистентно).

Зробити: обидва однакові (Apache-2.0 практика): власний копірайт + рядок атрибуції upstream: «This product includes software developed by OpenAI as part of codex-plugin-cc».

Verify: `diff` root і plugin NOTICE — ідентичні (крім шляхів за потреби).

### C5. Typos «a Antigravity» → «an Antigravity»

Файли: `plugins/antigravity/commands/review.md` (`:2`, `:8`), `plugins/antigravity/commands/adversarial-review.md` (`:2`).

Verify: grep «a Antigravity» у commands — 0.

### C6. plugin.json метадані

Файл: `plugins/antigravity/.claude-plugin/plugin.json`.

Зробити: додати `homepage`, `repository` (`github.com/kozaksv/antigravity-plugin-cc`), `license: "Apache-2.0"`, `keywords`.

Verify: `cd "<root>" && claude plugin validate` PASS (за наявності CLI); JSON парситься (`node --check` не для json — `node -e "JSON.parse(require('fs').readFileSync(...))"`).

### C8. splitRawArgumentString — бекслеші

Файл: `plugins/antigravity/scripts/lib/args.mjs` (`splitRawArgumentString` — `args.mjs:76-125`, escaping-гілка `:82-91`).

Зробити: бекслеш екранує ЛИШЕ наступні пробіл/лапку/бекслеш; перед іншими символами — literal. Тобто `C:\Users\x` виживає (бекслеші зберігаються), `\"` досі екранує лапку. Змінити гілку `if (escaping)` (`args.mjs:82-86`): якщо наступний символ ∈ {space, `'`, `"`, `\`} → додати символ (екрановано); інакше → додати `\` + символ (literal бекслеш).

Тести (`tests/` — новий `args.test.mjs` або в наявному):
- `C:\Users\x` → один токен `C:\Users\x` (бекслеші literal).
- `\"` всередині → екранована лапка.
- trailing-бекслеш у кінці аргументу → literal `\` (наявна гілка `:120`).
- подвійний бекслеш `\\` → один literal `\`.

Verify: `npm test` зелений.

### C9. `--timeout-ms 0`

Файл: `plugins/antigravity/scripts/antigravity-companion.mjs` (`timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT…)` — `antigravity-companion.mjs:317`, `valueOptions` timeout-ms — `:887`, `:896`).

Зробити: замінити `|| DEFAULT` на `Number.isFinite`-перевірку, щоб `0` = миттєвий снапшот без очікування (зараз `0 || DEFAULT` → DEFAULT). Від'ємні/NaN → наявна валідація/дефолт.

Тести (`tests/commands.test.mjs` або `runtime.test.mjs`):
- `--timeout-ms 0` → миттєвий снапшот (timeoutMs=0, не DEFAULT).
- від'ємне/NaN → дефолт.

Verify: `npm test` зелений.

---

## ФАЗА ДОКИ (можна паралельно з кодом; узгодити з A2/B1/B2)

### D1. A2-доки — Security posture

Файл: `README.md`.

Зробити: новий розділ «Security posture» — чесно про `--dangerously-skip-permissions` (потрібен, щоб headless-agy не висів), що дає/не дає `--sandbox`, що write-задачі НЕ ізольовані, місце для canary-результатів A2. Замінити тричі-повторену «will not perform any changes» (README:9, 97, 121) на чесне формулювання.

Verify: grep «will not perform any changes» у README — 0; розділ «Security posture» присутній.

### D2. B1-доки — effort

Файли: `plugins/antigravity/commands/rescue.md`, `plugins/antigravity/agents/antigravity-rescue.md`, `plugins/antigravity/skills/antigravity-cli-runtime/SKILL.md`.

Зробити: оновити значення (`low|medium|high`) й приклади effort.

### D3. B8 foreground timeout

Файли: `plugins/antigravity/commands/review.md`, `plugins/antigravity/commands/adversarial-review.md` (foreground-блоки), `plugins/antigravity/agents/antigravity-rescue.md` (foreground task).

Зробити: явно інструктувати Bash-виклик `timeout: 600000` (дефолт Claude Code 120s замалий).

Verify: grep `600000` у відповідних foreground-блоках.

---

## ФАЗА R — РЕЛІЗ

### R1. CHANGELOG 1.0.2 + bump + check-version

Файли: `plugins/antigravity/CHANGELOG.md`, `package.json`, `package-lock.json`, `plugins/antigravity/.claude-plugin/plugin.json`, marketplace.json (через bump-script).

Зробити (ОСТАННІМ, після всіх задач):
1. Запис CHANGELOG 1.0.2: quota-фікс `53e6e5f` (не потрапив у 1.0.1) + усі зміни цієї фічі. Явно відзначити breaking: B1 (effort звужено до `low|medium|high`), B4 (шлях стану XDG + одноразова міграція з /tmp), B7 (`shell:false`).
2. `cd "<root>" && npm run bump-version 1.0.2` (синхронізує package.json, lock, plugin.json, marketplace.json).
3. `cd "<root>" && npm run check-version` — гейт (розсинхрон 4 файлів версії → fail).

Verify: `npm run check-version` PASS; `npm test` зелений (включно з `bump-version.test.mjs`); `git -C "<root>" status --short` показує 4 версійні файли + CHANGELOG.

---

## Фінальна верифікація (перед PR)

1. `cd "<root>" && npm test` — усі (74 базові + нові) зелені.
2. `cd "<root>" && find plugins scripts tests -name '*.mjs' -print0 | xargs -0 -n 1 node --check`.
3. `cd "<root>" && npm run check-version`.
4. `claude plugin validate` PASS (за наявності CLI).
5. **A2 canary реального agy (ПЕРЕД релізом, ручний пост-мердж)**: під `--sandbox` write у tracked/untracked/outside-workspace + symlink-escape → ЗАБЛОКОВАНІ; self-collect під `--sandbox` → ПРАЦЮЄ. Результат у README «Security posture».
6. B5 stress-тест прогнати 3× (недетермінізм).

## Порядок і залежності

- B5 (локи + `saveStateUnlocked` + fail-closed) — **фундамент** для B3 (updateState на свіжому стані) і B4 (запис міграції під локом). Виконати B5 раніше за B3/B4 або в одній сесії з ними.
- B1 (модель-резолв) і C3 (дедуп `MODEL_ALIASES`→`resolveModelAlias`) чіпають один код — B1 перед C3 або спільно.
- A2 (`--sandbox` в `buildAgyArgs`) і B1 (модель в `buildAgyArgs`) і B2 (timeout в runOneShot/argv) — три задачі в `antigravity.mjs`, виконувати послідовно.
- D1 залежить від A2-рішення (гілка sandbox); D2 від B1; D3 незалежний.
- R1 — строго останній.
