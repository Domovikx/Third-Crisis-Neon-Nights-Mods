---
name: translate-qa
description: Offline QA for translations without launching the game — coverage, consistency, tag balance, length, latin leftovers. Use to review translation quality (RU now, DE/ES/PT/PL next).
---

# translate-qa — Офлайн-ревью переводов без запуска игры

Аналог Playwright для нашего кейса: Unity без исходников нельзя тестировать
headless-инструментами (Unity Test Framework требует source, Playwright — DOM,
которого нет). Поэтому два уровня:

1. **Статика (этот скилл, уже работает)**: проверки по данным без игры.
2. **Киноплёнка (потом)**: unattended-запуск игры + автосейв скриншотов через
   наш рантайм → filmstrip-HTML. Без него пока обходимся.

## Проверки (`scripts/qa_translate.py` — читает `po/template.pot` + `runtime/patch_<lang>.dat`)

`.dat` собирает `po2dat.mts`; `qa_translate.py` — Python-легаси, порт в
`tasks/2026-11-21-port-qa-and-translate.md`.

| #   | Проверка                                            | Уровень |
| --- | --------------------------------------------------- | ------- |
| 1   | Покрытие (общее / по папкам / по персонажам)        | info    |
| 2   | Copy-through в диалогах (`x == t`, не legacy)       | error   |
| 3   | Дисбаланс rich-тегов (`r` vs `rt`)                  | error   |
| 4   | Латиница в RU-переводе (кириллицы < 30%, не legacy) | warning |
| 5   | Дубли `(msgid, msgctxt)` с разным `msgstr` в PO     | error   |
| 6   | Пустые `x` для диалоговых записей POT               | error   |

Legacy-строки триажа (`sk` флаг) исключены из 2/4/6.

## Использование

```bash
node .opencode/skills/extract-text/scripts/po2dat.mts ru   # сначала свежий .dat
python .opencode/skills/translate-qa/scripts/qa_translate.py [--out tmp/qa.html]
# review_queue.py сейчас НЕ работает: нужен output/stable_index.json (удалён с extractor.py)
```

Выход QA: код 1 при наличии error; HTML-дашборд: карточки покрытия,
бары по персонажам, таблицы находок с путями файлов. Дашборд — в `tmp/`
(не трекается), рядом с `db_demo.html`.

## Матрица ревью по стадиям (обязательно на каждой)

| Стадия           | Чем ревьюим                                                                                                                                                                                  | Как                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Дамп (JSONL)     | `rg`/`jq` по `tmp/dump/*.jsonl` (построчно, без загрузки): `rg -l "beef" tmp/dump/*.jsonl`, `head -n 3 tmp/dump/level0.jsonl`                                                                | Живой поиск без SQL               |
| Извлечение       | A/B `potgen.mts` до/после изменений: повторный POT совпадает после нормализации `POT-Creation-Date`/`CRLF`                                                                                   | Ноль диффа = стадия чиста         |
| Перевод (PO)     | **Poedit** сейчас; **Weblate** (Docker, self-hosted) когда придут переводчики: глоссарий, TM, suggestions, скриншоты к строкам, matrix view RU/DE/ES, ревью-воркфлоу. Дока: docs.weblate.org | Контекст, память, approve-цепочка |
| Компиляция       | `po2dat.mts` отчёт (dupes/legacy/gated) + A/B словаря                                                                                                                                        | Расхождений с игрой-сегодня нет   |
| Качество         | `qa_translate.py` + `tmp/qa.html`                                                                                                                                                            | 6 правил, exit 1 при errors       |
| Очередь человеку | `review_queue.py` → `tmp/review_queue.html` (сейчас сломан: нужен `stable_index`, см. задачу порта)                                                                                          | Ответ номерами                    |
| Игра             | `NeonTranslator.log` (`Lang`, `Translations: N`) + киноплёнка (потом)                                                                                                                        | Финальный арбитр                  |

## Процесс ревью (как ревьюить, чтобы это было возможно)

Плоско ревьюить голые строки нельзя — нет контекста. Поэтому процесс трёхступенчатый:

1. **AUTO (машина)**: `prefill_po.py` (Python-референс, ждёт порта) подставляет переводы stripped-вариантам
   (`000 Aw ... 2` наследует от `Aw, ...!`) с флагом `auto-normalized` —
   162 штуки. В игру (`po2dat.mts`) они НЕ едут, пока человек не снимет флаг.
2. **Очередь (человек)**: `review_queue.py` строит `tmp/review_queue.html` —
   AUTO-секция на подтверждение + missing, сгруппированные по ассетам (сценам),
   у каждой строки соседи сверху/снизу с их переводами из stable_index.
   Ответ номерами → применение в `ru.po` → `.dat` → QA.
3. **Триаж видимости**: quest/FSM-метки (`TalkToKlaudia - 1_Agree`) — отдельной
   группой; если строка не показывается игроку — массовый skip, а не перевод.

## Тесты

```bash
python .opencode/skills/translate-qa/tests/qa_translate.test.py
```

Теста `review_queue` нет (он зависит от удалённого `stable_index`).
