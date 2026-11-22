# [2026-11-22] POT: сузить фильтр `isUiString` (длина, точка, скобки, отладка)

Статус: READY

## Цель

Перестать выбрасывать реальный текст игрока на эвристиках `isUiString`. Сейчас фильтр
заточен против Steam/Unity-шума, но рубит цели квестов, описания одежды, релиз-ноты,
кредиты и кнопки выбора.

## Контекст (замер 2026-11-22, `docs/pot-coverage-audit.md`)

`raw_strings`: 118 585 уникальных, 73 884 промаха. Причины (первая сработавшая проверка):

- `dot+upper` — 4 119. Из них «прозы» 737, видимых по выборке 60 %:
  `Look for keys.`, `Meet Nova in the bathroom.`, `Enter the Glowing Hole.`,
  `- Added a swollen pussy visuals.`, `Oh god- Fuck- fuck! Oh- holy shit.`
  (ложные срабатывания — состояния анимаций `Camera.Camera Move to Pussy`,
  `Base Layer.Start Walk Down`).
- `len>50` — 3 964. «Прозы» 467, видимых 72 %:
  `Take a picture of the advertisement for NeurAffinity`,
  `An electronic key used to unlock the laundry room…`,
  `Installing an extra battery into Exxy's drone… (+60 seconds)`.
- `parens` — 6 576. «Прозы» 220, видимых 40 %:
  `Sports Shorts (Black)`, `Lacey Bra (Black)`, `Dark Beanie Damaged With Pins (Furry)`.
- `code:*` — 416, из них видимые реплики: `Don't get in our way.`,
  `Sorry-... Just-... Don't Hhh-.. Mind me-...` (паттерн `don't` ловит обычную речь).
- `angle` — 6 285 (rich-теги и `->`): `Peek at them having sex.`,
  `Hold Sprint to BOOST!`, `Pinup Guest Artists`, `In Loving Memory`.

Адреса: `resources.jsonl:92770:raw_strings[]` (`Find a way forward.`),
`resources.jsonl:92820:raw_strings[]` (`Enter the Glowing Hole.`),
`level9.jsonl:81626:raw_strings[]` (`Hold Sprint to BOOST!`),
`level3.jsonl:41970:raw_strings[]` (`Peek at them having sex.`),
`resources.jsonl:93044:raw_strings[]` (релиз-ноты).

## Что сделать

1. `dot+upper`: отклонять только идентификатор — нет пробела после точки, или ≤3
   сегментов без пробелов, или известные префиксы `Base Layer.`, `Camera.`, `*.New State`,
   `Picture Flash.*`. Предложение с точкой и пробелом (`Look for keys.`) — пропускать.
2. Лимит 50: применять только к строкам без пробелов и/или без признаков прозы
   (`[a-z]{3}`, финальная пунктуация). Имя ассета с пробелом и цифрой (`… base_12 (3)`)
   отсекается отдельно.
3. `parens`: не отклонять строки вида `Название (Black)` / `(Furry)` / `(Up)` —
   это `strings.Name` одежды. Отклонять `(TMP)`, `(1)` в конце, `(set by …)`, `(pivot)`,
   `(world units …)`, части тела (`(Torso)`, `(Leg Back)`).
4. Отладочные паттерны (`don't`, `is not`, `handles`, `unity`) — только для строк без
   пробелов (сообщения кода) либо убрать из общего списка.
5. Замер до/после: сколько добавилось записей, сколько шума вернулось (выборка 50 из
   новых записей глазами). Порог: не более 2 % новых — шум, иначе правило сузить.

## Приёмка

- [ ] Все примеры выше попадают в POT (кроме явно невидимых)
- [ ] Новые записи: дельта и выборка 50 с вердиктами в журнале задачи
- [ ] Шум в новых записях ≤ 2 % (проверено выборкой)
- [ ] Старые записи POT не исчезли
- [ ] Паритет TS ↔ Rust побайтово
- [ ] Тесты: `50/51`, `Предложение с точкой.`, `Camera.Camera Move`, `Name (Black)`,
      `(TMP)`, `don't` в реплике и в сообщении кода

## Вне рамок

- Чтение типизированных полей (отдельная задача).
- Type tree для `*.assets` (отдельная задача).
- Удаление уже существующего шума из POT — `2026-11-21-pot-noise-cleanup.md`.

## Файлы

- `.opencode/skills/extract-text/scripts/inventory.mts` (`isUiString`)
- `.opencode/skills/pipeline-common/scripts/text_filters.mts`
- `tools/rust-l10n/src/inventory.rs`, `tools/rust-l10n/src/text_filters.rs`
- `.opencode/skills/extract-text/tests/inventory.test.mts`

## Связи

- `docs/pot-coverage-audit.md`.
- `tasks/2026-11-21-pot-coverage-gaps.md` — предыдущий (более узкий) заход.
