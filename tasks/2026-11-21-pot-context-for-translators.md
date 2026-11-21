# [2026-11-21] Вернуть переводчику контекст: сцена/ассет в POT или рядом

Статус: READY

## Задача от пользователя

«перепроверять все экстракторы и то как формируется pot po всего ли там достаточно,
понятно ли как работает… большое ревью с оптимизанией и кайдзэн делаем.»

## Цель

Переводчик должен понимать, **где** строка встречается: сцена, ассет, соседние
реплики. Сейчас POT даёт только `msgctxt` (спикер) и `#. rich_text`, а провенанс
(`#:` refs) не пишется вовсе.

## Контекст (проверено 2026-11-21)

- `potgen.mts` намеренно не пишет `#:` refs (`renderPot`), в шапке
  `extract-text/SKILL.md` это зафиксировано.
- `po2dat` от этого зависит: `refKey` возвращает `~` для всех записей, и
  дубликаты одного `msgid` разрешает порядок файла (`earliest-ref-file-wins`).
- `find_source.py` — единственный инструмент провенанса, он Python-легаси и
  импортирует удалённый `potgen.py` (не запускается).
- `review_queue.py` без `output/stable_index.json` (удалён вместе с
  `extractor.py`) не работает: очередь ревью с соседними строками потеряна.
- В дампе провенанс есть: `asset` + `path_id` + `type`, `idx` внутри диалога;
  `inventory` его уже собирает (`source`), но `potgen` выбрасывает.

## Что сделать

1. Выбрать формат (KISS, без ломки паритета `.dat`):
   - вариант A: вернуть `#:` refs в POT (`[src:<asset>#<path_id>]`), проверить,
     что `po2dat` продолжает работать и дубли разрешаются осмысленно;
   - вариант B: sidecar `tmp/pot-sources.jsonl` + скрипт
     `context.mts <msgid>` для переводчика/QA, POT не трогаем.
     Предпочтение — B, если A даёт шум в диффах переводов (каждый апдейт POT).
2. Порт `find_source.py` → `find_source.mts` (читает дамп и POT, ищет по
   `msgid`), с тестом на мини-фикстуре.
3. В переводческом промпте (`translate-local`) добавить 3 строки контекста
   вокруг целевой (из sidecar/дампа), если это не раздувает запрос: сейчас
   контекст = только спикер и соседние msgid в батче.
4. Заменить `review_queue.py` на `.mts`-версию, которая берёт соседей из дампа
   (не из `stable_index`) — либо явно закрыть задачу как ненужную, если
   sidecar закрывает потребность.
5. Обновить `extract-text/SKILL.md` («провенанс ищется по дампу») и
   `translate-qa/SKILL.md`.

## Приёмка

- `find_source.mts "<текст>"` печатает `asset/path_id/type/idx` и соседние
  реплики; тест на `tiny-dump` зелёный.
- POT/`.dat` не изменились (если выбран вариант B) либо дифф объяснён и
  `po2dat`-паритет подтверждён (вариант A).
- Переводчику доступен контекст ≥3 строк для любой строки из POT.
- `tasks/2026-11-21-port-qa-and-translate.md` обновлён: `review_queue`
  закрыт этим решением или оставлен как отдельный пункт.

## Вне рамок

- Перевод строк и правка `po/*.po`.
- Weblate/веб-редактор.

## Файлы

- `.opencode/skills/extract-text/scripts/potgen.mts` (refs/sidecar)
- `.opencode/skills/extract-text/scripts/inventory.mts` (сохранение контекста)
- новый `.opencode/skills/extract-text/scripts/find_source.mts`
- `.opencode/skills/extract-text/scripts/po2dat.mts` (проверка `refKey`)
- `.opencode/skills/translate-local/scripts/translate_local.py` (контекст)
- `.opencode/skills/translate-qa/scripts/review_queue.py` (замена)

## Связи

- Порт PO-инструментов: `tasks/2026-11-21-port-po-tools.md`.
- QA и перевод: `tasks/2026-11-21-port-qa-and-translate.md`.
- Отчёт: `docs/review-2026-11-21.md`.
