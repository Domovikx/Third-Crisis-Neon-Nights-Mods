---
name: translate-qa
description: Офлайн-QA перевода без запуска игры — покрытие, copy-through, баланс rich-тегов, латиница в RU, дубли; плюс очередь ручного ревью в HTML. Движок правил — Rust (tools/rust-qa), HTML — TypeScript, золотой отчёт — оракул.
---

# translate-qa — офлайн-ревью переводов без запуска игры

Аналог Playwright для нашего кейса: Unity без исходников нельзя тестировать
headless-инструментами (Unity Test Framework требует source, Playwright — DOM,
которого нет). Поэтому два уровня:

1. **Статика (этот скилл, работает)**: проверки по данным без игры.
2. **Киноплёнка (потом)**: unattended-запуск игры + автосейв скриншотов через
   наш рантайм → filmstrip-HTML. Без него пока обходимся.

## Где что лежит

- **Движок правил — `tools/rust-qa`** (Rust, единственный). Команда —
  `node scripts/qa.mts --lang <код> --out tmp/qa.html` (обёртка: запускает
  `rust-qa`, печатает сводку, рисует HTML-дашборд на TS).
- **Золотой отчёт — `.opencode/skills/translate-qa/test_data/qa-golden-<lang>.json`**
  (+ входы `test_data/fixture-<lang>/`). Это ОРАКУЛ: гейт
  `tests/qa_golden.test.mts` сверяет с ним Rust побайтово по структуре (сводка,
  `by_speaker`/`by_dir`, находки — **в порядке**).
- **Очередь ревью — `.opencode/skills/translate-qa/scripts/review_queue.mts`** (TS).
- TS-движок правил (`qa_translate.mts`) **удалён 2026-11-24** (решение владельца
  «всё TS-легаси выпиливаем»): его роль разделена — правила на Rust, HTML на TS,
  эталон — золотой JSON.

## Проверки (6 правил, Rust)

Читает `po/template.pot` (очередь работ) + `runtime/patch_<lang>.dat` (истина
«что реально уехало в игру»):

- **1. Покрытие** — всего / по папкам / по персонажам (`msgctxt "speaker:X"`), info.
- **2. Copy-through** в диалогах (`x === t`, не legacy) — error.
- **3. Дисбаланс rich-тегов** (`r` против `rt`) — error.
- **4. Латиница в RU-переводе** (кириллицы < 30 %, строка > 10 символов, не legacy) — warning.
- **5. Дубли** `(msgid, msgctxt)` с разным `msgstr` в `po/<lang>.po` — error.
- **6. Пустой `x`** для диалоговой записи из POT — error.

Legacy-строки триажа (флаг `sk` из `#, legacy`) исключены из 2/4/6; строки с
`#, no-translate` и `#, skip` — из всех содержательных правил.

**Длина перевода не критерий** (`AGENTS.md`): `> 10 символов` в правиле 4 —
порог поиска непереведённой латиницы, а не оценка длины. Лимитов длины в QA нет
и добавлять их нельзя.

## Команды

```bash
npm run qa:build                     # собрать движок (один раз): tools/rust-qa
npm run po2dat -- ru                 # сначала свежий .dat
node scripts/qa.mts --lang ru --out tmp/qa.html
node .opencode/skills/translate-qa/scripts/review_queue.mts [--lang ru] [--limit 100]
```

QA печатает сводку и возвращает **код 1 при наличии error** (CI-ready).
HTML-дашборд: карточки покрытия, бары по персонажам, таблица находок с
фильтром; лежит в `tmp/` (не трекается).

`.dat` собирает `rust-l10n po2dat` — **QA читает `.dat`, а не только PO**. Если
`.dat` старый, отчёт врёт про покрытие: сначала `po2dat`, потом QA.

## Золотой отчёт (оракул): как пересобирать

Золото снято 2026-11-24 с TS-эталона (коммит `ed8657e`), там же подтверждено
побайтовое совпадение отчётов TS и Rust. После удаления эталона TS-стороны нет:
**пересборка золота = принятие нового базиса**, делать осознанно.

```bash
node .opencode/skills/translate-qa/test_data/build_golden.mts
```

Скрипт берёт срез ЖИВОГО корпуса в `test_data/fixture-<lang>/` (все строки,
дающие находки, плюс сэмпл «чистых» для статистики) и перезаписывает
`qa-golden-<lang>.json` отчётом Rust. Фикстура нужна потому, что живой `po/`
меняется каждый день: тест на нём был бы красным по чужой работе, а не по
регрессу QA. Дифф золота в git — это и есть ревью изменения правил.

## Очередь ревью (`scripts/review_queue.mts`)

Процессный фикс против «ревьюить голые строки — это угадайка»:

- **AUTO (машина)**: строки с `#, auto-normalized` — подстановки по
  нормализации, человек подтверждает. В игру они не едут, пока флаг не снят.
- **missing (человек)**: пустые `msgstr`, сгруппированные по спикеру
  (`msgctxt`), у каждой строки соседи сверху/снизу с их переводами.
- **Триаж видимости**: quest/FSM-метки (`TalkToKlaudia - 1_Agree`) — отдельная
  метка `quest/fsm`; если строка не показывается игроку — массовый skip, а не перевод.

**Честная замена `output/stable_index.json`** (его создавал удалённый
`extractor.py`): строки берутся из `po/<lang>.po`, спикер — из `msgctxt`.
Следствие, написанное прямо в HTML: соседи — по порядку в po-файле (он
отсортирован по тексту), а не по сцене; сцен в PO больше нет. Вернуть сценовый
контекст может только refs в POT (`tasks/2026-11-21-pot-context-for-translators.md`).

Ответ человека — номерами (`A1..` / `M1..`); применение в `po` → `.dat` → QA.

## Матрица ревью по стадиям (обязательно на каждой)

- **Дамп (JSONL)** — `rg`/`jq` по `tmp/dump/*.jsonl` построчно, без загрузки.
- **Извлечение** — A/B `potgen` до/после: ноль диффа после нормализации даты.
- **Перевод (PO)** — Poedit сейчас; Weblate (self-hosted) когда придут
  переводчики: глоссарий, TM, suggestions, скриншоты к строкам, matrix view.
- **Компиляция** — отчёт `po2dat` (dupes/legacy/gated) + A/B словаря.
- **Качество** — `node scripts/qa.mts` + `tmp/qa.html`: 6 правил, exit 1 при errors.
- **Очередь человеку** — `review_queue.mts` → `tmp/review_queue.html`.
- **Игра** — `mods/NeonTranslatorDX/NeonTranslatorDX.log` (`Lang`, `Translations: N`) + киноплёнка (потом).

## Тесты

```bash
node --test .opencode/skills/translate-qa/tests/qa_golden.test.mts \
            .opencode/skills/translate-qa/tests/qa_rules.test.mts \
            .opencode/skills/translate-qa/tests/review_queue.test.mts \
            scripts/qa_render.test.mts
```

- `qa_golden` — Rust против золотого JSON (структура + порядок находок).
- `qa_rules` — поведение 6 правил и исключений на построчных фикстурах.
- `qa_render` (`scripts/`) — HTML-дашборд и конвертация отчёта Rust на TS.
- `review_queue` — очередь ручного ревью.

Без собранного `rust-qa` Rust-тесты пропускаются (не падают). Фикстуры — во
временных `tmp/qa-*`, в сеть никто не ходит.
