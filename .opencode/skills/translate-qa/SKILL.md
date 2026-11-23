---
name: translate-qa
description: Офлайн-QA перевода без запуска игры — покрытие, copy-through, баланс rich-тегов, латиница в RU, дубли; плюс очередь ручного ревью в HTML. Node/TypeScript (.mts), без зависимостей.
---

# translate-qa — офлайн-ревью переводов без запуска игры

Аналог Playwright для нашего кейса: Unity без исходников нельзя тестировать
headless-инструментами (Unity Test Framework требует source, Playwright — DOM,
которого нет). Поэтому два уровня:

1. **Статика (этот скилл, работает)**: проверки по данным без игры.
2. **Киноплёнка (потом)**: unattended-запуск игры + автосейв скриншотов через
   наш рантайм → filmstrip-HTML. Без него пока обходимся.

## Проверки (`scripts/qa_translate.mts`)

Читает `po/template.pot` (очередь работ) + `runtime/patch_<lang>.dat` (истина
«что реально уехало в игру»).

- **1. Покрытие** — всего / по папкам / по персонажам (`msgctxt "speaker:X"`), info.
- **2. Copy-through** в диалогах (`x === t`, не legacy) — error.
- **3. Дисбаланс rich-тегов** (`r` против `rt`) — error.
- **4. Латиница в RU-переводе** (кириллицы < 30 %, строка > 10 символов, не legacy) — warning.
- **5. Дубли** `(msgid, msgctxt)` с разным `msgstr` в `po/<lang>.po` — error.
- **6. Пустой `x`** для диалоговой записи из POT — error.

Legacy-строки триажа (флаг `sk` из `#, legacy`) исключены из 2/4/6; строки с
`#, no-translate` — из всех содержательных правил.

**Длина перевода не критерий** (`AGENTS.md`): `> 10 символов` в правиле 4 —
порог поиска непереведённой латиницы, а не оценка длины. Лимитов длины в QA нет
и добавлять их нельзя.

## Команды

```bash
npm run po2dat -- ru                 # сначала свежий .dat
node .opencode/skills/translate-qa/scripts/qa_translate.mts [--lang ru] [--out tmp/qa.html]
node .opencode/skills/translate-qa/scripts/review_queue.mts [--lang ru] [--limit 100]
```

QA печатает сводку в stderr и возвращает **код 1 при наличии error** (CI-ready).
HTML-дашборд: карточки покрытия, бары по персонажам, таблица находок с
фильтром; лежит в `tmp/` (не трекается).

`.dat` собирает `rust-l10n po2dat` — **QA читает `.dat`, а не только PO**. Если `.dat`
старый, отчёт врёт про покрытие: сначала `po2dat`, потом QA.

## Очередь ревью (`scripts/review_queue.mts`)

Процессный фикс против «ревьюить голые строки — это угадайка»:

- **AUTO (машина)**: строки с `#, auto-normalized` — подстановки по
  нормализации, человек подтверждает. В игру они не едут, пока флаг не снят.
- **missing (человек)**: пустые `msgstr`, сгруппированные по спикеру
  (`msgctxt`), у каждой строки соседи сверху/снизу с их переводами.
- **Триаж видимости**: quest/FSM-метки (`TalkToKlaudia - 1_Agree`) — отдельная
  метка `quest/fsm`; если строка не показывается игроку — массовый skip, а не перевод.

**Честная замена `output/stable_index.json`** (его создавал удалённый
`extractor.py`, поэтому Python-версия падала/выдавала пустоту): строки берутся
из `po/<lang>.po`, спикер — из `msgctxt`. Следствие, написанное прямо в HTML:
соседи — по порядку в po-файле (он отсортирован по тексту), а не по сцене;
сцен в PO больше нет. Вернуть сценовый контекст может только refs в POT
(`tasks/2026-11-21-pot-context-for-translators.md`).

Ответ человека — номерами (`A1..` / `M1..`); применение в `po` → `.dat` → QA.

## Матрица ревью по стадиям (обязательно на каждой)

- **Дамп (JSONL)** — `rg`/`jq` по `tmp/dump/*.jsonl` построчно, без загрузки.
- **Извлечение** — A/B `potgen.mts` до/после: ноль диффа после нормализации даты.
- **Перевод (PO)** — Poedit сейчас; Weblate (self-hosted) когда придут
  переводчики: глоссарий, TM, suggestions, скриншоты к строкам, matrix view.
- **Компиляция** — отчёт `po2dat` (dupes/legacy/gated) + A/B словаря.
- **Качество** — `qa_translate.mts` + `tmp/qa.html`: 6 правил, exit 1 при errors.
- **Очередь человеку** — `review_queue.mts` → `tmp/review_queue.html`.
- **Игра** — `NeonTranslator.log` (`Lang`, `Translations: N`) + киноплёнка (потом).

## Тесты

```bash
node --test .opencode/skills/translate-qa/tests/qa_translate.test.mts \
            .opencode/skills/translate-qa/tests/review_queue.test.mts
```

Тесты работают на временных фикстурах (`tmp/qa-*`, `tmp/rq-*`), в сеть не ходят.

Миграция: Python-версии (`scripts/qa_translate.py`, `scripts/review_queue.py`)
остаются референсом до удаления — не править и не звать.
