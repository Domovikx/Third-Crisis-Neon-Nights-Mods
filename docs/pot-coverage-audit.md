# Аудит покрытия POT — что из видимого игроку текста не доходит до перевода

Дата: 2026-11-22. Задача: `tasks/2026-11-22-pot-coverage-audit.md`.
Режим: **только чтение** — `po/`, код пайплайна и дамп не менялись (проверка — раздел
«Воспроизводимость и чистота»).

Данные: `tmp/dump-new` (147 чанков + `summaries.jsonl`, 578 474 объектов и 169
summary-строк, 19 сцен), `po/template.pot` (40 256 записей), игра
`C:\Program Files (x86)\Steam\steamapps\common\Third Crisis Neon Nights` (DLL `#US`-куча).

## Короткий ответ

**Да, видимый игроку текст за пределами POT есть.** По замеру и выборкам — около
**1 000 уникальных строк** (оценка 950–1 050), которые игрок видит, но которых нет в
`po/template.pot`. Это не «мелочь»: цели и шаги квестов, описания одежды и предметов,
подсказки галереи, релиз-ноты, кредиты, часть строк интерфейса настроек Lovense/сохранений.

Крупные источники пробела, по убыванию вклада:

1. **Типизированные поля в `*.assets` не читаются вообще** (`read_failed`, 96 % объектов):
   в `level*.jsonl`, `sharedassets*.jsonl`, `resources.jsonl` нет type tree, поэтому
   `strings`/`fields`/`fsm_strings` пусты. Текст выживает только в `raw_strings` (байтовый
   скан), где его режут фильтры. Это корневая причина большинства промахов.
2. **Фильтр `isUiString`** рубит настоящий текст: лимит 50 символов, эвристика «точка +
   заглавная», правило «есть и `(`, и `)`», отладочные подстроки (`don't`, `is not`, `handles`…).
3. **Поля `strings.*` с UI-текстом не извлекаются вовсе** (инвентарь читает только
   `m_Name` для bundle-логики): `Description`, `DefaultDisplayName`, `UnlockHint`,
   `DisplayName`, `Name`, `m_text`, `UseText`, `TakenFromInventoryText`.
4. **`global_strings` не читается никем** — 57 539 уникальных строк в дампе, 891 «похожая
   на текст», но почти всё — заметки разработчика и обрывки скана.
5. **`#US`-куча DLL обрезается лимитом top-500** — 251 UI-кандидат отрезан, 237 из них
   нет в POT (в основном отладка, но ~20–30 — видимые строки Lovense/сохранений).
6. **`raw_strings` обрезан 100 строками на объект** (1 790 объектов, 276 из них с диалогами)
   — хвост строк объекта не доходит даже до фильтра.

Полностью покрыты (подтверждено, не «кажется»): `dialogues[]`, `fsm_strings[]`,
`settings_keys[].display` (включая 689 строк из `#US`). Не требуют перевода вовсе
(технические): `color_parser_list`, служебные поля `strings.*` (`Guid`, `m_ClassName`…),
строковые массивы `fields.*[]` (имена спрайтов/ключей шейдеров/скинов).

## Что именно измерялось

POT сверялся как множество `msgid` с тремя ступенями нормализации (от строгой к мягкой):

- **точно** — `msgid` совпадает байт-в-байт (PO уже разэкранирован парсером);
- **после снятия rich-тегов** (`<i>`, `<color=…>`, `<b>`) и trim;
- **«ядро»** (`core`) — снимаются числовой префикс `NN-`, `VAZoey - NNN - `, разметка
  `_i_`/`_b_`/`_color=…_`, апострофы, пунктуация, хвостовой номер дубля. Нужен потому,
  что `raw_strings` и имена озвучки — это те же реплики в «сырой» оболочке.

Нормализация «ядро» помечена отдельно, чтобы не выдать дубликат за пробел: 4 787 строк
`raw_strings` — это сырые варианты текста, который в POT уже есть.

Воспроизведение POT: `potgen.mts --dump tmp/dump-new --out tmp/audit/pot-from-dump.pot`
даёт **40 256 записей**, идентичных `po/template.pot` (разница только в
`POT-Creation-Date`). Значит инвентарь и POT согласованы, и все промахи ниже — это
именно то, что фильтры/источники **не отдали** в инвентарь, а не потеря на рендере.

## Инвентарь и матрица покрытия

| Источник                  | Строк   | Уникальных | В POT  | Промах     | Причина промаха                                    | Видимо игроку               |
| ------------------------- | ------- | ---------- | ------ | ---------- | -------------------------------------------------- | --------------------------- |
| `dialogues[].text`        | 8 023   | 7 287      | 7 287  | **0**      | — (диалоги не фильтруются)                         | 100 % покрыто               |
| `fsm_strings[]`           | 129     | 46         | 46     | **0**      | —                                                  | 100 % покрыто               |
| `settings_keys[].display` | 746     | 726        | 726    | **0**      | —                                                  | 100 % покрыто               |
| `raw_strings[]`           | 840 281 | 118 585    | 44 701 | **73 884** | `isUiString` (таблица ниже)                        | ~900 из них                 |
| `global_strings[]`        | 75 795  | 57 539     | 10 282 | **47 257** | источник не читается                               | ~45 из них                  |
| `strings.*`               | 21 988  | 4 778      | 1 539  | **3 239**  | UI-поля не извлекаются; остальное — идентификаторы | 28 (UI-поля)                |
| `fields.*[]`              | 5 623   | 288        | 200    | **88**     | не извлекается                                     | нет (спрайты/шейдеры/скины) |
| `color_parser_list`       | 10      | 10         | 1      | **9**      | не извлекается                                     | нет (цвета/hex)             |
| `#US`-куча DLL            | 751     | 751        | 514    | **237**    | лимит top-500                                      | ~25                         |

Пояснения к числам:

- В `raw_strings` «в POT» = 38 165 точных совпадений + 6 536 сырых вариантов (числовой
  префикс/разметка) = 44 701. Остальные 73 884 — промахи.
- `strings.*`: 21 988 — это все строковые значения всех объектов с type tree (bundle).
  В `level`/`sharedassets`/`resources` таких значений в дампе **ноль** — не потому что их
  нет в игре, а потому что объекты `read_failed`.
- `#US`-куча: сканер дампа отдаёт в `settings_keys` не больше 500 UI-строк на сборку.
  Все 500 дошли до POT; 251 отрезано лимитом, 237 из них в POT отсутствуют.

Что именно лежит в 73 884 промахах `raw_strings` (по содержимому, а не по причине):

- **видимая проза — 1 470 строк**: из них 737 `dot+upper`, 467 `len>50`, 220 `parens`
  (названия одежды), 27 `code:*`, 19 `angle`. Это цели и шаги квестов, описания одежды и
  предметов, релиз-ноты, кредиты, письма, часть реплик.
- **служебное — 72 414 строк**: состояния анимаций/камер (`Base Layer.*`, `Camera.*`),
  пути FSM, имена ассетов и частей моделей, GUID/hex, свойства шейдеров, имена SFX и
  озвучки, обрывки JSON/бинаря.

Из 3 239 промахов `strings.*`: `asset-name` 3 178, `identifier` 98, `UI-поля` 36,
`typed-other` 13, `url` 4.

Из 47 257 промахов `global_strings`: «похожая на прозу» 1 120, после вычета дублей
`raw_strings` — 891; из них видимых/пригодных по выборке ~5 %.

### Причины промахов `raw_strings` (точные числа, первая сработавшая проверка)

| Причина                                                  | Строк  | Что это                                            |
| -------------------------------------------------------- | ------ | -------------------------------------------------- |
| `not-label`                                              | 42 225 | не подошло ни одно правило лейбла (идентификаторы) |
| `parens`                                                 | 6 576  | есть `(` и `)`                                     |
| `angle`                                                  | 6 285  | есть `<` или `>` (rich-теги и `->`)                |
| `dot+upper`                                              | 4 119  | точка + заглавная в первых 5 символах              |
| `len>50`                                                 | 3 964  | длиннее 50 code points                             |
| `caps-novowel`                                           | 3 863  | ALL CAPS без гласной (бинарь)                      |
| `guid` / `hex`                                           | 4 042  | GUID и hex-строки                                  |
| `brace`                                                  | 1 315  | есть `{` или `}`                                   |
| `shader-prop`                                            | 711    | `_CamelCase`                                       |
| `path-prefix`, `both-slashes`, `filename`, `asset-state` | 365    | пути и имена файлов                                |
| отладочные паттерны (`code:*`)                           | 416    | `don't`, `is not`, `handles`, `unity` …            |
| `ui-reject-name`, `untrimmed`                            | 3      | прочее                                             |

## Что покрыто полностью (подтверждено)

- **`dialogues[]` — 100 %.** 8 023 строки, 7 287 уникальных, все 7 287 — `msgid` в POT.
  Диалоги не фильтруются триажем: что извлечено из `dialogues[]`, то в POT есть всегда.
  Оговорка: это полнота «относительно извлечённого», полноту самого извлечения см.
  раздел про озвучку.
- **`fsm_strings[]` — 100 %.** 129 строк, 46 уникальных, все в POT.
- **`settings_keys[].display` — 100 %.** 746 строк, 726 уникальных (20 дублей), все в POT.
  Сюда же входят 689 строк из `#US`-кучи DLL (см. ниже).
- **`color_parser_list` — техническое, переводить нечего.** 5 имён цветов (`money`,
  `flashback`, `pure`, `positive`, …) и hex-значения; они нужны только для подстановки
  `<color=…>` в рантайме. В POT попал 1 hex случайно (как часть другой строки).
- **`fields.*[]` — по существу покрыто.** 288 уникальных значений, 200 в POT; 88 промахов —
  проверены выборкой: `m_PackedSpriteNamesToIndex` (имена спрайтов), `m_ValidKeywords`
  (ключи шейдеров), `DialogueSpineSkins`/`OverworldSpineSkins` (пути скинов). Текста
  игрока здесь нет.
- **`strings.*` служебные поля — переводить нечего:** `Guid` (28 уникальных), `guid` (26),
  `TranslationGuid` (17) — ни одного в POT и не нужно; `m_AssemblyName`, `m_ClassName`,
  `m_Namespace`, `boneName`, `m_SourceFontFileGUID`, `OverworldSpineBaseSkin`,
  `m_AssetBundleName` — идентификаторы. Исключение — UI-поля из матрицы выше.

### Адреса покрытых категорий (примеры)

`dialogues[]` (все три строки — `msgid` в POT):

- `bundle_0.3-animation-maxxcustomercg….jsonl:-5271052525308704000:dialogues[0].text` =
  `Whoa, your hair is changing colors!`
- `bundle_0.3-animation-maxxcustomercg….jsonl:-4513733326656519000:dialogues[0].text` =
  `Wow, your nails look amazing!`
- `bundle_0.3-animation-maxxcustomercg….jsonl:3220992949410604000:dialogues[0].text` =
  `Feeling curious about what's between my legs, hun~?`

`fsm_strings[]` (покрыто, но содержимое техническое — имена событий; кандидат в фильтр шума):

- `bundle_3dsuitcasescene….jsonl:-9118446906516876000:fsm_strings[0]` = `clicked`
- `bundle_3dsuitcasescene….jsonl:-8909643174941208000:fsm_strings[0]` = `entered`
- `bundle_3dsuitcasescene….jsonl:-7340132754392198000:fsm_strings[0]` = `clicked`

`settings_keys[].display` (все в POT):

- `resources:summaries.settings_keys[]` — `Settings.ControlsTab` → `Controls`
- `dll_Assembly-CSharp:summaries.settings_keys[]` — `Settings.ShowAdvancedPerformanceStats` →
  `Show Advanced Performance Stats`
- `dll_Assembly-CSharp:summaries.settings_keys[]` — `Settings.EnableSkipMode` →
  `Enable Skip Mode`

`fields.*[]` (технические, переводить нечего):

- `bundle_0.3-animation-maxxcustomercg….jsonl:-8944958931698833000:fields.m_ValidKeywords[]` =
  `_STRAIGHT_ALPHA_INPUT`
- `bundle_0.3-animation-maxxcustomercg….jsonl:-8639006321473104000:fields.m_ValidKeywords[]` =
  `_ALPHAPREMULTIPLY_ON`
- `bundle_0.3-animation-maxxcustomercg….jsonl:-8183063032759576000:fields.m_ValidKeywords[]` =
  `_ALPHAPREMULTIPLY_ON`

`color_parser_list` (техническое):

- `resources.jsonl:90974:color_parser_list.money` = `#F0BE23`; там же `flashback` → `#969696`,
  `pure` → `#449DEF`, `positive` → `#00FF00`.

## Что видит игрок вне POT: оценка и как она получена

Точного числа дать нельзя: «видимость» определяется тем, что игра реально рисует, а не
полем дампа. Поэтому ниже — уникальные строки, разбитые на «прозу» (похоже на текст
игрока) и «служебное», с проверкой выборок по 40 строк на корзину.

| Корзина                             | Уникальных | Видимых по выборке | Оценка   |
| ----------------------------------- | ---------- | ------------------ | -------- |
| `raw` проза, `dot+upper`            | 737        | 24/40 (60 %)       | ~440     |
| `raw` проза, `len>50`               | 467        | 29/40 (72 %)       | ~340     |
| `raw` проза, `parens`               | 220        | 16/40 (40 %)       | ~90      |
| `raw` проза, `code:*`               | 27         | ~60 %              | ~16      |
| `raw` проза, `angle`                | 19         | ~60 %              | ~12      |
| `strings.*` UI-поля (сверх `raw`)   | 6          | 4/6                | ~4       |
| `global_strings` (уникальная проза) | 891        | ~5 %               | ~45      |
| `#US`, отрезано лимитом             | 237        | ~10 %              | ~25      |
| **Итого**                           |            |                    | **~970** |

Диапазон честной оценки — **950–1 050 уникальных строк**. Это меньше, чем «38 223
человекочитаемых промаха» из грубого среза (там в прозу попадали имена ассетов
с пробелами и состояния анимаций), и больше, чем «~512» из ревью 2026-11-21 — см.
«Почему числа разошлись».

Отдельно, **не входит в оценку**: 155 имён озвучки, для которых нет ни диалога в дампе,
ни `msgid` в POT (см. «Сомнительное»). Если игра рисует по ним субтитры — это ещё
до ~155 строк.

### Почему числа разошлись с прошлым замером

Прошлый замер (`docs/review-2026-11-21.md`, `tasks/2026-11-21-pot-coverage-gaps.md`)
давал **33 271 запись POT и ~900 промахов**, из них ~512 «видимых». Расхождение
объясняется четырьмя вещами, а не ошибкой:

1. **Дамп другой.** Тогда было 131 чанк и 477 572 объекта (сцены 0..15, старый
   Python-дампер). Сейчас 147 чанков и 578 474 объекта: добавлены `level16..18` и
   `sharedassets16..18` (обнаружение сцен по факту файлов, 2026-11-22). POT вырос
   33 271 → 40 256 (+6 985 записей), потому что в нём появился текст трёх сцен.
2. **Нормализация другая.** Прошлый замер склеивал `NN-`-префиксы и пунктуацию одной
   эвристикой; здесь три ступени, поэтому сырые варианты реплик (4 787) считаются
   покрытыми, а не пробелом — зато промахи, которые раньше «закрывались» нормализацией,
   видны отдельно.
3. **Категории считаются раздельно.** Раньше `global_strings`, `strings.*` и `#US`
   не разбирались поштучно. Теперь у них свои числа: 47 257 + 3 239 + 237 промахов,
   из которых видимых — десятки, а не сотни.
4. **Оценка видимости сделана по выборкам, а не «на глаз по всему списку»**, поэтому
   она ниже механического «38 223» и выше прежних «512».

## Выборка промахов с вердиктом

Адрес = `файл дампа : path_id : поле`. Все строки ниже отсутствуют в POT (проверено
скриптом), если не указано иное.

### Видимо игроку

1. `Just an old pair of shorts to wear around my apartment.` —
   `bundle_0.3-animation-maxxcustomercg….jsonl:-9057854576939689000:strings.Description` —
   описание одежды в инвентаре; ушло и как поле (не читается), и как `len>50`.
2. `This bra from BluFit promises a sleek sports bra…` —
   `bundle_0.3-animation-maxxcustomercg….jsonl:-5816339113266571000:strings.Description` —
   видимо (описание одежды).
3. `Lio's stuck in some sort of sex machine. I've gotta get him out of there!` —
   `bundle_lewdanimation_liofuckmachine….jsonl:-3777503652685613000:strings.Description` —
   видимо (описание журнала).
4. `Look for keys.` — `bundle_lewdanimation_liofuckmachine….jsonl:-5319264188927289000:strings.DefaultDisplayName` —
   видимо (цель квеста); причина `dot+upper`.
5. `Put the second key into the machine.` —
   `bundle_lewdanimation_liofuckmachine….jsonl:1634476808158378200:strings.DefaultDisplayName` —
   видимо (шаг квеста).
6. `Have a close look at Rosies breasts.` —
   `bundle_sexscene-rosietitjob….jsonl:8825886232141749000:strings.UnlockHint` —
   видимо (подсказка галереи).
7. `Visit the bathroom in room 205 during Zoey's dream sequence.` —
   `bundle_0.3pinup-dreamposter….jsonl:-5331264470147386000:strings.UnlockHint` — видимо, `len>50`.
8. `Inspect Max's crotch.` —
   `bundle_0.3-animation-maxxcustomercg….jsonl:-4765487522941733000:raw_strings[]` — видимо, `dot+upper`.
9. `Find a way forward.` — `resources.jsonl:92770:raw_strings[]` — видимо (цель квеста).
10. `Enter the Glowing Hole.` — `resources.jsonl:92820:raw_strings[]` — видимо.
11. `Meet Nova in the bathroom.` — `resources.jsonl:92960:raw_strings[]` — видимо.
12. `Remove the trash and leave this area.` — `level9.jsonl:80820:raw_strings[]` — видимо.
13. `Help Leona find her cat.` — `sharedassets14.jsonl:845:raw_strings[]` — видимо.
14. `Take a picture of the advertisement for NeurAffinity` — `resources.jsonl:91013:raw_strings[]` —
    видимо, `len>50`.
15. `Very expensive pants that would match great with a Blazer and a shirt.` —
    `resources.jsonl:91546:raw_strings[]` — видимо (описание одежды).
16. `An electronic key used to unlock the laundry room at the Soaring Nidus building.` —
    `resources.jsonl:92029:raw_strings[]` — видимо (описание предмета).
17. `Installing an extra battery into Exxy's drone allows her to record your Xhibition Runs for longer. (+60 seconds)` —
    `resources.jsonl:92053:raw_strings[]` — видимо (описание апгрейда).
18. `- Added a button to the bottom left of the screen that hides the character sprite during gameplay.` —
    `resources.jsonl:93044:raw_strings[]` — видимо (релиз-ноты).
19. `Bonus damage added to the base damage of lust abilities.` —
    `resources.jsonl:93086:raw_strings[]` — видимо (описание навыка).
20. `The unforeseen changes to the main system will result in a delay of five to seven working days.` —
    `resources.jsonl:92138:raw_strings[]` — видимо (письмо в игре).
21. `The original PlaidPLAY collection restored by DripWEAR!…` —
    `resources.jsonl:91856:raw_strings[]` — видимо (описание одежды).
22. `Barely managing to escape the glowing hole, Zoey needs to lay low…` —
    `resources.jsonl:92205:raw_strings[]` — видимо (описание главы/релиз-ноты).
23. `(I- I can't stop after all this without the full pay. Just-... finish this... )` —
    `resources.jsonl:92651:raw_strings[]` — видимо (реплика).
24. `Sports Shorts (Black)` — `resources.jsonl:92322:raw_strings[]` — видимо (название одежды), `parens`.
25. `Lacey Bra (Black)` — `resources.jsonl:91874:raw_strings[]` — видимо (название одежды), `parens`.
26. `Dark Beanie Damaged With Pins (Furry)` — `resources.jsonl:91559:raw_strings[]` — видимо, `parens`.
27. `Pinup Guest Artists` — `level17.jsonl:28098:raw_strings[]` — видимо (кредиты), `angle`.
28. `In Loving Memory` — `level17.jsonl:28098:raw_strings[]` — видимо (кредиты).
29. `Peek at them having sex.` — `level3.jsonl:41970:raw_strings[]` — видимо (кнопка выбора), `angle`.
30. `Hold Sprint to BOOST!` — `level9.jsonl:81626:raw_strings[]` — видимо (подсказка UI), `angle`.
31. `Double click the input field with mouse, or navigate with a controller` —
    `resources.jsonl:120431:raw_strings[]` — видимо (подсказка UI).
32. `We've left you a new camera in your room. Install this one in a better place…` —
    `sharedassets7.jsonl:1176:raw_strings[]` — видимо (письмо).
33. `That's... That can't be. She hasn't been an outdoor cat in so long, she wouldn't just...` —
    `sharedassets14.jsonl:857:raw_strings[]` — видимо (реплика).
34. `Overwrite Save` — `dll_Assembly-CSharp` (`#US`, отрезано лимитом 500) — видимо
    (диалог сохранения).
35. `Lovense Toy Search` — `dll_Assembly-CSharp` (`#US`, отрезано) — видимо (панель Lovense).

### Не видимо игроку (примеры того, что «ловится» автоматикой зря)

36. `Camera.Camera Move to Pussy` — `bundle_sexscene-chairsaloncg….jsonl:-6269642169164620000:raw_strings[]` —
    состояние анимации камеры.
37. `Base Layer.Start Walk Down` — `resources.jsonl:4872:raw_strings[]` — состояние Animator.
38. `sactx-1-2048x2048-DXT5|BC3-Ad - Corrupt Technologies 3-2ff95dbe` —
    `bundle_0.2pinup-ad-corrupttechnologies3….jsonl:-5590209279805383000:raw_strings[]` — имя атласа.
39. `Andro 5 (Torso)` — `resources.jsonl:92251:raw_strings[]` — часть модели.
40. `Perversion Cost Text (TMP)` — `resources.jsonl:16362:raw_strings[]` — имя GameObject.
41. `Sucking Noise - Very Wet Oral Vaginal… Source Recording - 78 [008490]` —
    `bundle_jaydoggyassetgroup….jsonl:221809568883826800:raw_strings[]` — имя SFX.
42. `Lower Redlight District - Girls Flashing - 6 - Give Marker - 2` —
    `resources.jsonl:92888:raw_strings[]` — путь FSM.
43. `Hidden/TCNN/NaN Catcher` — `dll_Assembly-CSharp` (`#US`) — путь шейдера.
44. `Master/VA/Sex Scene VA` — `dll_Assembly-CSharp` (`#US`) — путь аудиомикшера.
45. `SaveManager: Saving game:` — `dll_Assembly-CSharp` (`#US`) — отладочный лог.
46. `Did we grab the Bunnysuit already?` — `level3:summaries.global_strings[]` — заметка
    разработчика (FSM-флаг), не текст игрока.
47. `This whole section was cut from the game` — `level7:summaries.global_strings[]` —
    заметка разработчика.
48. `Either way I've gotta wait for my contract broker to contact me. They'll be calling any moment now.` —
    `sharedassets5:summaries.global_strings[]` — обрывок реальной реплики; как `msgid`
    непригоден (источник режет строку на не-ASCII), а полной версии в `raw_strings` нет.

### Сомнительное

49. **[СОМНИТЕЛЬНО]** `This is a really long task name that manages to go into line 2` —
    `resources.jsonl:98306:raw_strings[]` — похоже на тестовую заглушку UI; если это
    показывается в игре, строка видима.
50. **[СОМНИТЕЛЬНО]** `Walk back out` — `level13:summaries.global_strings[]` — похоже на
    подпись выбора/шага, но в `raw_strings` полной записи нет: возможно, это FSM-метка,
    а не текст кнопки. Проверять только глазами в игре.
51. **[СОМНИТЕЛЬНО]** 155 имён озвучки без диалога и без POT, например
    `I'm not his maid, darling.` (`sharedassets14.jsonl`, AudioClip),
    `Leona asked about ya. She was wondering if you'd come see her.` (`sharedassets17.jsonl`, AudioClip),
    `You're tasty...` — в дампе нет ни `dialogues[]` с этим текстом, ни `msgid`.
    Либо это голос без субтитра, либо диалоговая запись не дампится (см. задачу).
52. **[СОМНИТЕЛЬНО]** `Come here, bitch.` — `level6:summaries.global_strings[]` — единственная
    найденная в `global_strings` реплика-обращение; в `raw_strings` полной версии нет,
    значит строку нельзя безопасно взять из `global_strings` без ручной сверки.

## Причины и стоимость исправления

Дешёвые правки правилом (без ручного отбора, эффект — сотни строк):

- **Читать UI-поля `strings.*` напрямую** (`Description`, `DefaultDisplayName`,
  `UnlockHint`, `DisplayName`, `Name`, `m_text`, `UseText`, `TakenFromInventoryText`) —
  они по определению текст игрока, фильтр `isUiString` к ним не нужен. Это ~36 строк
  уже в bundle-дампах и потенциально сотни в `level`/`resources`, когда заработает
  type tree.
- **Сузить `dot+upper`**: отклонять только идентификатор (нет пробела после точки или
  ≤3 сегментов без пробелов, `Base Layer.*`, `Camera.*`, `*.New State`), а не любое
  предложение с точкой.
- **Поднять/снять лимит 50 для прозы**: длинная строка с пробелами, `.!?` и строчными
  буквами — это текст, а не имя ассета. Имена ассетов отсекаются по `(N)`, `_` и
  CamelCase.
- **Отдельное правило для названий одежды**: `Capitalized words (Black)`, `(Furry)`,
  `(Up)` — это `strings.Name`, а не имя ассета.
- **Убрать отладочные подстроки из общего фильтра** (`don't`, `is not`, `handles`,
  `unity`) или применять их только к строкам без пробелов.
- **Снять лимит top-500 в `#US`** и не тащить в POT отладочный лог (фильтр по
  `LOVENSE:`/`SaveManager:`/`Material '`/пути шейдеров).

Дорогая, но корневая правка:

- **Type tree для `*.assets`**: 96 % объектов (`level`, `sharedassets`, `resources`)
  сейчас `read_failed`, потому что в этих файлах нет встроенного дерева типов. Без него
  не читаются ни `strings.*` (описания/квесты), ни `fields`, ни `fsm_strings`. Это
  Rust-задача: встроенные схемы классов Unity (как в UnityPy) + чтение по ним. Эффект —
  не «сотни строк», а полный доступ к типизированному тексту 555 616 объектов.

Ручной отбор (не автоматизируется надёжно):

- `global_strings` (891 «проза»): 90 % — заметки разработчика, обрывки и дубли; включать
  только после триажа, иначе POT распухнет мусором.
- Релиз-ноты, кредиты, титры: объём большой, текст устаревает. Решение владельца уже
  есть — «включая ноты», но переносить их лучше отдельным блоком и с проверкой глазами.
- 155 «озвучек без диалога»: сначала проверить в живой игре, рисуются ли по ним субтитры.

## Чего мы не видим в принципе

- **Текст, запечённый в картинки и спрайты** (логтипы, вывески, UI-арт, «релиз-ноты» как
  текстуры). В дампе его нет и не будет: нужна замена изображений или оверлей, это вне
  рамок текстового мода.
- **Шрифтовые атласы TMP** — не текст, а глифы.
- **Аудио** — вне рамок проекта (только текст).
- **Штатный селектор языка** — `StreamingAssets/Languages/` пуст (только
  `Placeholder.txt`), альтернативного источника строк нет; язык переключает наш оверлей.
- **Имена ассетов, сцен, анимаций, FSM-состояний** — не рендерятся; их попадание в POT
  (4 859 «triaged» записей) — шум, а не покрытие (отдельная задача
  `2026-11-21-pot-noise-cleanup.md`).

## Созданные задачи

- `tasks/2026-11-22-pot-typed-ui-fields.md` — читать UI-поля `strings.*` без фильтра.
- `tasks/2026-11-22-pot-ui-filter-narrowing.md` — сузить `dot+upper`, лимит 50, правило
  скобок; отдельно названия одежды.
- `tasks/2026-11-22-pot-read-failed-typetree.md` — type tree для `*.assets` (корневая
  причина, Rust).
- `tasks/2026-11-22-pot-raw-strings-cap.md` — обрезка `raw_strings` на 100 строках.
- `tasks/2026-11-22-pot-global-strings-triage.md` — триаж `global_strings`.
- `tasks/2026-11-22-pot-us-heap-cap.md` — лимит top-500 в `#US` + фильтр отладки.
- `tasks/2026-11-22-voice-clips-without-dialogue.md` — 155 озвучек без диалога в дампе;
  проверить E2E, рисуются ли субтитры.

## Воспроизводимость и чистота

Скрипты аудита (в git не попадают, лежат в `tmp/`):

- `tmp/pot_audit.mts` — инвентарь источников + покрытие + классификация;
- `tmp/classify_misses.mts`, `tmp/prose_split.mts`, `tmp/prose_by_reason.mts`,
  `tmp/final_stats.mts`, `tmp/overlap.mts`, `tmp/numbers.mts` — срезы и выборки;
- `tmp/rf_stats.mts` — `read_failed` и обрезка по классам ассетов;
- `tmp/dll_audit.mts` — независимый проход по `#US` без лимита;
- `tmp/voice_proxy.mts`, `tmp/voice_fuzzy.mts` — сверка имён озвучки с POT.

Прогон:

```bash
node .opencode/skills/extract-text/scripts/potgen.mts --dump tmp/dump-new --out tmp/audit/pot-from-dump.pot
node tmp/pot_audit.mts tmp/dump-new
node tmp/rf_stats.mts tmp/dump-new
node tmp/dll_audit.mts
```

Проверка чистоты: `po/template.pot` совпадает с пересобранным (разница — только
`POT-Creation-Date`); в `po/`, `.opencode/`, `tools/`, `package.json`, `AGENTS.md`,
`tasks/README.md` правок этого аудита нет. `git status` на момент отчёта содержит только
чужие параллельные изменения (их не трогали) и новые файлы аудита.

## Ограничения отчёта

- «Видимо/не видимо» — суждение по адресу, объекту и имени поля; четыре пункта помечены
  `[СОМНИТЕЛЬНО]`, для 155 озвучек — гипотеза, требующая проверки в игре.
- Оценка ~970 строк — по выборкам 40 на корзину; доверительный интервал грубый
  (±10 %), он отражает неопределённость «рендерится ли это».
- `raw_strings` в дампе обрезаны 100 строками на объект, поэтому даже полный перебор
  дампа не покажет хвосты 1 790 объектов — реальных промахов может быть больше.
