# Стеля 600 с для agy — прибрати з плагіна й протягнути з обгортки

**Статус:** спека диригента (сесія debug-missing-usage-stats, 2026-09-04). Вердикт людини: «він падає по таймауту не з причини моделі, а тому, що ти не дочекався».

## Вимір (24 год до 2026-09-04 ~09:00, квитанції `.git/fp-pair/*/*/receipt.json` двох репо)
- agy: 24 виклики; 11 з exitCode=1 і output РІВНО `Error: timeout waiting for response` (36 Б); тривалість усіх 11 — **604–616 с** при оголошеній стелі 900/1500/1800/2400 с; 13 успішних — усі ≤ 603 с. У 9 з 11 «провалів» файли на диску написані (до 15 файлів).
- codex успішні до 1021 с, qwen до 2831 с → диригенти чекати вміють; каплений лише agy.

## Корінь
`plugins/antigravity/scripts/lib/antigravity.mjs`:
- `const PRINT_TIMEOUT = "600s"` (рядок 41) → `buildAgyArgs` (371) передає `--print-timeout 600s` завжди; `options.printTimeout` існує, але жоден каллер `task` його не передає (`handleTask` valueOptions = model|effort|cwd|prompt-file).
- Зовнішній кілл `DEFAULT_TURN_TIMEOUT_MS = 15 хв` (39), env `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS` (`resolveTurnTimeoutMs`, 485).
- Обгортки (FP `scripts/fp_hands/legacy.py:174`, `gateways.py:_antigravity_argv`; Health `scripts/fp-pair-call.sh:18-21`) кличуть `node companion task --cwd <cwd> <prompt>` БЕЗ таймауту — `--timeout N` обгортки для agy фікція.

## Контракт після фікса

### П1. Плагін (обидва проєкти одразу — спільний шлях `~/.claude/plugins/marketplaces/antigravity/...`)
1. Нова експортована `resolvePrintTimeout(options)` у `lib/antigravity.mjs`. Пріоритет: `options.printTimeout` (рядок-тривалість agy, напр. `"2400s"`, або число секунд) → env `ANTIGRAVITY_COMPANION_PRINT_TIMEOUT` → дефолт = `turnTimeoutMs − 30 000 мс` у секундах (тобто при 15 хв кілла — `870s`). Невалідне env → stderr-нота + дефолт (як у `resolveTurnTimeoutMs`).
2. **Інваріант:** print-timeout < зовнішнього кілла ЗАВЖДИ. Якщо print задано явно (флаг/env) і воно ≥ turn: turn підіймається до `print + 60 с` — КРІМ випадку, коли `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS`/`options.timeoutMs` задано явно; тоді print клампиться до `turn − 30 с` і пишеться stderr-нота. Обидва значення — з однієї функції `resolveTurnBudget(options) → {turnTimeoutMs, printTimeout}`; `spawnAgyTurn` і `buildAgyArgs` беруть значення ЛИШЕ з неї.
3. `task` (foreground і `--background`) приймає `--print-timeout <dur>`; значення тече `handleTask → buildTaskRequest → executeTaskRun → runTurn → runOneShot → spawnAgyTurn` (у збережений job-request — щоб `task-worker` реплей не загубив). Проба `getAntigravityAvailability` (669–672, `printTimeout:"45s"`, `timeoutMs:60s`) — НЕ чіпати.
4. Док: `docs/agy-cli.md` § print-timeout і `README.md:304` — новий дефолт, флаг, env, інваріант.

### П2. Обгортка FP (`scripts/fp_hands/`)
5. `legacy.py` agy-гілка: `run_argv = ["node", companion, "task", "--cwd", cwd, "--print-timeout", f"{timeout}s", prompt_text]`; `env["ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS"] = str((timeout + 60) * 1000)`. `gateways.py:_antigravity_argv` — те саме для маршрутного режиму (timeout з плану). Квитанція `timeoutSec` стає правдою для agy.
6. Класифікація в `fp-pair-call.sh`: якщо output.txt (після trim) == `Error: timeout waiting for response` → у квитанції `timedOut: true`, `reasons` містить `printTimeout` замість `exitNonZero`; при `wroteFileCount > 0` додається `diskWritten` (сигнал диригенту забрати результат з диска, не переробляти).

## Не робимо
- Не міняємо `--timeout` дефолти рук (900 для agy в Health лишається; після фікса він ЧЕСНИЙ).
- Не чіпаємо codex/qwen гілки.
- Health-обгортка НЕ правиться цією спекою: їй фікс дістається через новий дефолт плагіна (870 с print / 15 хв кілл при зовнішньому `timeout 900`).
