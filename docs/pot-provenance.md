# Провенанс строк POT — откуда строка взялась

Дата: 2026-11-22. Задача: `tasks/2026-11-22-pot-provenance.md`.
Режим: **только измерение** — состав POT не менялся (ни один фильтр не
добавлен, ничего не удалено), меняется только формат записи: добавлен
комментарий `#. src: <метка>`.

Данные: `tmp/dump-after` (новый дамп без обрезок текста: 149 JSONL-файлов,
134 МБ) и тот же `scanDump`, которым собирается POT. POT — **143 871 запись**
(143 872 блока `msgid` вместе с шапкой). Число записей совпадает с версией без
меток побайтово, кроме добавленных строк `#. src:` и `POT-Creation-Date`.

## Короткий ответ

Внешний вид строки ничего не решает: метка `src` — объективный путь, которым
строка пришла в POT. По числам видно главное:

- **76,1 % POT (109 543 записи) — 22 класса `raw:*`, где текста нет**
  (Font, TextAsset, Mesh, Sprite, MonoScript, Transform, коллайдеры…).
  На них приходится **471 строка «прозы» — 3,3 % всей прозы**. Остальные
  **34 328 записей несут 13 705 прозы (96,7 %)**.
- Один только `raw:TextAsset` — **45 030 записей (31,3 %)** при 0,9 % прозы;
  `raw:Font` — **44 200 (30,7 %)** при 0,0 %; `raw:Mesh` — **10 625 (7,4 %)**
  при 0,0 %. Это и есть «~100 тысяч обрывков блобов» из замера.
- Прозой плотны `dialog` (84,2 %), `us` (64,2 %), `settings` (26,9 %),
  `raw:AudioClip` (51,7 % — имена озвучки), `raw:MonoBehaviour` (38,3 %),
  `field:*` (35,6 %), `raw:GameObject` (24,7 %).
- `global` инвентарь **не читает вовсе**: 57 539 уникальных кандидатов в
  дампе, 11 803 из них уже в POT другим путём (через `raw:*`), 4 034 —
  похожи на прозу. Решение по этому источнику — отдельное.

Следствие для политики (реализовано — раздел «Политика отбора по `src`»):
отбор по `src` даёт сокращение POT на 45,5 % ценой 1,4 % прозы (первый набор
меток — 5 самых «идентификаторных» классов `raw:*`), тогда как любой «фильтр
по внешнему виду» режет прозу и пропускает мусор (см. `dot+upper` в контексте
задачи). Полный набор из 22 классов дал бы −76 % ценой −3,3 % прозы; какие
ещё метки добавлять — решение владельца (список с числами — в разделе политики).

## Метки (фиксированный список)

| `src`             | Откуда строка                                             | Кто ставит                                  |
| ----------------- | --------------------------------------------------------- | ------------------------------------------- |
| `dialog`          | структура диалогов ANToolkit                              | `dialogues[]`                               |
| `bundle`          | PlayMaker-бандл (`line_X`)                                | `raw_strings` бандла с `line_`              |
| `field:<ИмяПоля>` | значение типизированного поля объекта                     | `strings.<поле>` / `fields.<поле>[]`        |
| `settings`        | `settings_keys[].display`, ключ `Settings.*`              | `summaries.jsonl`                           |
| `us`              | автономная UI-строка из кучи `#US` DLL (`key == display`) | `summaries.jsonl`, `format: dotnet_us_heap` |
| `raw:<TypeName>`  | raw-скан объекта (Texture2D, AudioClip, Font…)            | `raw_strings` строки объекта                |
| `global`          | глобальные строки (`global_strings`)                      | **сегодня не читается** — 0 записей         |

Правила:

- Метка — путь **доставки** строки в POT, а не «где ещё она встречается».
  При дедупе по `(msgid, msgctxt)` побеждает первое вхождение — как у
  `rich_text`.
- `field:<ИмяПоля>` ставится только если значение найдено в типизированном
  поле **того же объекта** (type tree). В `*.assets`/`*.resource` type tree
  нет (`read_failed`), поэтому там текст остаётся `raw:<TypeName>` — это
  честно показывает, что поле неизвестно, а не угадывает его.
- `field:fsm` — строки PlayMaker FSM: это значения типизированного поля `fsm`.
- `us` отличается от `settings` по ключу: в DLL-строке `Settings.*` — это
  настоящая настройка (подпись синтезирована из имени), а запись, где
  `key == display`, — автономная UI-строка из `#US`.
- Имена спикеров (`msgctxt speaker-name`) получают метку источника, где имя
  впервые появилось: `dialog` или `bundle`.

## Мягкий тест «похоже на прозу»

`looksLikeProse` — **метрика отчёта, не фильтр** (и не повод что-то
исключать). Условия: ≥3 слов, ≥3 слова содержат ≥2 букв, ≥50 % символов —
буквы, ≤5 % символов вне «обычной» пунктуации (`.,!?'"…:;()-–—[]/`).
Проверено на шуме: `!+5=DHISSSSSSSSSSQOJC;1'` и `H?nX7?ML` прозой не
считаются, `Turn to Zoey` и `Where are you going now, my dear friend?` —
считаются. Тест намеренно мягкий: он показывает **долю похожего на текст**,
а решение принимается по `src`.

## Политика отбора по `src`

Дата: 2026-11-22. Реализация — `potgen` обеих реализаций (Rust — рабочий путь,
TS — эталон); политика лежит **данными** в `config/pot-src-policy.json`:
смена набора меток не требует правки кода.

### Файл политики

```json
{
  "exclude": ["raw:Font", "raw:Mesh", "raw:MonoScript", "raw:Texture2D", "raw:Sprite"],
  "include": ["*"]
}
```

- `exclude` — метки `#. src:`, которые **не попадают в POT**. Шаблон — точная
  метка (`raw:Font`) или префикс с `*` (`raw:Tex*`, `raw:*`, `field:*`).
- `include` — что вообще допускается: `["*"]` — всё (обычный режим);
  список без `*` работает как белый список (`["dialog", "raw:*"]`).
- Неизвестное поле (`exlude`), битый JSON, пустой `include` и **неизвестная
  метка** (`raw:Fontt`, `dilog`) — ошибка прогона, а не молчаливое «ничего не
  исключено». Ошибкой считаются только реальные опечатки: список классов
  сверен с дампером (`unity_classes.mts`), а `field:<Поле>` открыт (новые поля
  появляются при обновлении игры).
- Поля с `_` — комментарии данных (не исполняются).

### Что исключается сейчас

Только «идентификаторные» raw-классы: в них нет текста игрока, а тест на прозу
ловит имена шрифтов, сертификаты, имена файлов атласов и релиз-картинок.

| `src`            | исключено | «проза» | что за «проза» (выборка)                                      |
| ---------------- | --------: | ------: | ------------------------------------------------------------- |
| `raw:Font`       |    44 200 |      22 | `Droid Sans Mono`, `Microsoft Code Signing PCA`               |
| `raw:Mesh`       |    10 625 |       2 | `Skeleton Prefab Mesh [Spine GameObject]`                     |
| `raw:Sprite`     |     4 573 |      37 | `Ad Static - Bunnygirl`, `Corrupt Technologies - Logo - Icon` |
| `raw:Texture2D`  |     3 109 |     132 | `0.2 Release Notes Hero 1 - Neon City`, `Atlas Residential …` |
| `raw:MonoScript` |     2 887 |       2 | `Mirror light movement on sprite`, `Touch Object 2d Event`    |
| **итого**        |    65 394 |     195 | 1,4 % всей прозы POT (14 176)                                 |

### Замер (дамп `tmp/dump-after`, 2026-11-22)

| режим        |           записей |              размер |    TS |  Rust |
| ------------ | ----------------: | ------------------: | ----: | ----: |
| без политики |           143 871 |            8,79 MiB | 4,1 с | 2,6 с |
| с политикой  |            78 477 |            5,26 MiB | 3,9 с | 2,7 с |
| **дельта**   | −65 394 (−45,5 %) | −3,70 MiB (−40,2 %) |     — |     — |

POT с политикой и без — **побайтово одинаков** у TS и Rust; журнал исключённых
тоже побайтово (`tests/potgen.test.mts`: «паритет TS ↔ Rust: POT и журнал
байт-в-байт (с политикой и без)»).

### Куда деваются исключённые

`tmp/pot-excluded.jsonl` — по строке на запись, порядок POT (`msgid`, затем
`msgctxt`), ничего не теряется молча:

```json
{ "src": "raw:Font", "msgid": "! $n+Nl", "msgctxt": "ui", "reason": "exclude:raw:Font" }
```

`reason` — `exclude:<шаблон>` или `not-included` (не прошло `include`).
Файл пишется атомарно (`.part` с PID → rename), пустая политика даёт пустой
файл.

### Где применяется

К **записям каталога** — после дедупа по `(msgid, msgctxt)`, по метке `src`,
которая победила («первое вхождение»). Поэтому исключённая запись не
возвращается через другой источник: её метка уже определена. Отчёт прогона
печатает `policy: excluded N, kept M` и разбивку по меткам, а `POT(dry)` —
число записей и размер в MiB.

```bash
node .opencode/skills/extract-text/scripts/potgen.mts --dump tmp/dump-after --out tmp/pot.pot
node .opencode/skills/extract-text/scripts/potgen.mts --no-policy --out tmp/all.pot   # как до политики
node .opencode/skills/extract-text/scripts/potgen.mts --policy config/pot-src-policy.json
node .opencode/skills/extract-text/scripts/potgen.mts --excluded tmp/pot-excluded.jsonl
# Rust — те же флаги: npm run potgen -- --no-policy / --policy <path> / --excluded <path>
```

### Что осталось решить владельцу

- **`raw:TextAsset`** — 45 030 записей (31,3 % POT) при 405 «прозе» (0,9 %).
  Самый большой рычаг; но TextAsset — это ещё и текстовые ресурсы игры, поэтому
  по умолчанию НЕ исключён: нужен ручной просмотр 405 строк.
- **`raw:GameObject`** — 6 958 записей, но 1 719 прозы (24,7 %) — имена
  объектов видны игроку; оставлен.
- **`raw:MonoBehaviour`** — 8 461 запись, 3 239 прозы (38,3 %) — больше всего
  реального текста; оставлен.
- **`raw:AudioClip`** — 1 536 записей, 794 «прозы» — это имена файлов озвучки
  (`VAZoey - 174 - …`), переводить не нужно, но и в POT они не вредят; решение
  отдельное.
- **`raw:Material`/`raw:Shader`/`raw:AnimatorController`** — 252/1 738/686
  записей, «прозы» 144/190/154 (имена материалов и шейдерных ключей); тоже
  кандидаты, но требуют просмотра.
- **`global`** — инвентарь этот источник не читает вовсе (57 539 кандидатов,
  4 034 «прозы»); это вопрос покрытия, а не политики.

## Как воспроизвести

```bash
# полный отчёт (таблицы + примеры) — тот, что в приложении ниже
node scripts/pot_provenance_report.mts --dump tmp/dump-after

# машинный вид
node scripts/pot_provenance_report.mts --dump tmp/dump-after --json

# POT с метками (в tmp/, po/ не трогается)
node .opencode/skills/extract-text/scripts/potgen.mts --dump tmp/dump-after --out tmp/pot-labels.pot

# паритет TS ↔ Rust и контракт
npm run l10n:build
node scripts/text_parity.test.mts   # или npm test
node scripts/pot_invariants.mts tmp/pot-labels.pot --dump tmp/dump-after
```

## Ограничения измерения

- **Первое вхождение побеждает.** Одна и та же строка может встречаться в
  разных источниках; метка показывает тот, что дошёл до каталога первым.
  Пересечения видны в колонках «ключей» vs «в POT» и в разделе `global`.
  Порядок дампа влияет на **1 172 записи** (`dialog` ↔ `bundle`/`raw`):
  строка, лежащая и в `dialogues[]`, и в бандле, получает метку того
  источника, что встретился раньше. Классы `dialog` и `bundle` поэтому
  частично перекрываются — при политике это учитывать.
- **`field:` только при type tree.** `level*.jsonl`, `sharedassets*.jsonl`,
  `resources.jsonl` типизированных полей не несут, поэтому поле там
  неизвестно и метка — `raw:<TypeName>`.
- **`raw:AudioClip` «проза» — это имена файлов озвучки** (`VAZoey - 174 - …`),
  а не реплики: полезно как индикатор, но переводить их не нужно.
- **`raw:Font`/`raw:TextAsset` «проза» — сертификаты, имена шрифтов, пути
  Spine-скелетов**; это подтверждает, что класс шумный, но не отменяет
  ручного просмотра выборочных 471 строки перед политикой.
- **`global` не доставляется** инвентарём; пересечение с POT посчитано по
  `msgid` (текст уже в POT через `raw:*`), а не означает, что источник
  прочитан.

## Полное распределение и примеры

> Числа и примеры ниже печатает `scripts/pot_provenance_report.mts` на `tmp/dump-after`
> (выборка примеров — равномерная и детерминированная). В документе таблицы
> выровнены prettier; значения — из прогона скрипта.

| `src`                              | в инвентаре |     ключей |      в POT | доля POT |     проза | проза в классе |
| ---------------------------------- | ----------: | ---------: | ---------: | -------: | --------: | -------------: |
| `dialog`                           |        8076 |       7610 |       7352 |    5.1 % |      6187 |         84.2 % |
| `bundle`                           |         103 |         16 |         16 |    0.0 % |         9 |         56.3 % |
| `field:ArtistName`                 |           3 |          3 |          3 |    0.0 % |         0 |          0.0 % |
| `field:ArtistURL`                  |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `field:Bind`                       |           1 |          1 |          0 |    0.0 % |         0 |              — |
| `field:DisplayName`                |          43 |         41 |         41 |    0.0 % |         3 |          7.3 % |
| `field:FadeOutBoolName`            |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `field:Name`                       |          21 |         21 |         15 |    0.0 % |         5 |         33.3 % |
| `field:TakenFromInventoryText`     |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `field:UnknownName`                |           2 |          2 |          1 |    0.0 % |         0 |          0.0 % |
| `field:UseText`                    |           2 |          2 |          1 |    0.0 % |         0 |          0.0 % |
| `field:boneName`                   |          27 |         27 |         27 |    0.0 % |         2 |          7.4 % |
| `field:category`                   |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `field:fsm`                        |          46 |         18 |         18 |    0.0 % |         0 |          0.0 % |
| `field:m_AssemblyName`             |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `field:m_AtlasTags`                |          19 |         19 |         19 |    0.0 % |        14 |         73.7 % |
| `field:m_ClassName`                |          47 |         47 |         46 |    0.0 % |         0 |          0.0 % |
| `field:m_FontNames`                |           3 |          3 |          3 |    0.0 % |         0 |          0.0 % |
| `field:m_Name`                     |         929 |        927 |        925 |    0.6 % |       366 |         39.6 % |
| `field:m_Namespace`                |           3 |          3 |          3 |    0.0 % |         0 |          0.0 % |
| `field:m_PackedSpriteNamesToIndex` |          81 |         81 |         81 |    0.1 % |        35 |         43.2 % |
| `field:m_text`                     |           9 |          9 |          9 |    0.0 % |         2 |         22.2 % |
| `field:slotName`                   |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `settings`                         |          94 |         78 |         78 |    0.1 % |        21 |         26.9 % |
| `us`                               |         900 |        898 |        897 |    0.6 % |       576 |         64.2 % |
| `raw:AnimationClip`                |        1912 |       1911 |       1911 |    1.3 % |        87 |          4.6 % |
| `raw:Animator`                     |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `raw:AnimatorController`           |         692 |        687 |        686 |    0.5 % |       154 |         22.4 % |
| `raw:AnimatorOverrideController`   |           5 |          5 |          5 |    0.0 % |         0 |          0.0 % |
| `raw:AssetBundle`                  |         136 |        136 |        136 |    0.1 % |         0 |          0.0 % |
| `raw:AudioClip`                    |        1541 |       1536 |       1536 |    1.1 % |       794 |         51.7 % |
| `raw:AudioMixerController`         |          33 |         31 |         31 |    0.0 % |        12 |         38.7 % |
| `raw:AudioMixerGroupController`    |           2 |          2 |          2 |    0.0 % |         0 |          0.0 % |
| `raw:AudioSource`                  |           4 |          4 |          4 |    0.0 % |         0 |          0.0 % |
| `raw:BoxCollider`                  |         112 |        112 |        112 |    0.1 % |         0 |          0.0 % |
| `raw:Camera`                       |           1 |          1 |          1 |    0.0 % |         0 |          0.0 % |
| `raw:CanvasRenderer`               |           2 |          2 |          2 |    0.0 % |         0 |          0.0 % |
| `raw:ComputeShader`                |          55 |         55 |         55 |    0.0 % |         6 |         10.9 % |
| `raw:CustomRenderTexture`          |           1 |          1 |          1 |    0.0 % |         1 |        100.0 % |
| `raw:Font`                         |       44203 |      44200 |      44200 |   30.7 % |        22 |          0.0 % |
| `raw:GameObject`                   |        6989 |       6969 |       6958 |    4.8 % |      1719 |         24.7 % |
| `raw:Material`                     |         252 |        252 |        252 |    0.2 % |       144 |         57.1 % |
| `raw:Mesh`                         |       10625 |      10625 |      10625 |    7.4 % |         2 |          0.0 % |
| `raw:MeshFilter`                   |           2 |          2 |          2 |    0.0 % |         0 |          0.0 % |
| `raw:MonoBehaviour`                |        9791 |       8718 |       8461 |    5.9 % |      3239 |         38.3 % |
| `raw:MonoScript`                   |        2888 |       2888 |       2887 |    2.0 % |         2 |          0.1 % |
| `raw:ParticleSystem`               |           3 |          3 |          3 |    0.0 % |         0 |          0.0 % |
| `raw:PhysicMaterial`               |           1 |          1 |          1 |    0.0 % |         1 |        100.0 % |
| `raw:RectTransform`                |          94 |         94 |         94 |    0.1 % |         0 |          0.0 % |
| `raw:RenderTexture`                |           7 |          7 |          7 |    0.0 % |         3 |         42.9 % |
| `raw:Shader`                       |        1751 |       1738 |       1738 |    1.2 % |       190 |         10.9 % |
| `raw:ShaderVariantCollection`      |           3 |          3 |          3 |    0.0 % |         0 |          0.0 % |
| `raw:SkinnedMeshRenderer`          |           5 |          5 |          5 |    0.0 % |         0 |          0.0 % |
| `raw:SphereCollider`               |           2 |          2 |          2 |    0.0 % |         0 |          0.0 % |
| `raw:Sprite`                       |        4574 |       4573 |       4573 |    3.2 % |        37 |          0.8 % |
| `raw:SpriteAtlas`                  |         613 |        613 |        613 |    0.4 % |         3 |          0.5 % |
| `raw:SpriteRenderer`               |         124 |        124 |        124 |    0.1 % |         0 |          0.0 % |
| `raw:SpriteShapeRenderer`          |          30 |         30 |         30 |    0.0 % |         0 |          0.0 % |
| `raw:TextAsset`                    |       45030 |      45030 |      45030 |   31.3 % |       405 |          0.9 % |
| `raw:Texture2D`                    |        3109 |       3109 |       3109 |    2.2 % |       132 |          4.2 % |
| `raw:Transform`                    |        1105 |       1105 |       1105 |    0.8 % |         0 |          0.0 % |
| `raw:VideoClip`                    |           1 |          1 |          1 |    0.0 % |         1 |        100.0 % |
| `raw:VisualEffect`                 |          10 |         10 |         10 |    0.0 % |         2 |         20.0 % |
| `raw:VisualEffectAsset`            |          14 |         14 |         14 |    0.0 % |         0 |          0.0 % |
| **итого**                          |  **146138** | **144412** | **143871** |    100 % | **14176** |          9.9 % |

`global` в инвентаре 0: этот источник сегодня НЕ читается (см. раздел ниже). Сумма «ключей» больше «в POT» на удалённые ui-двойники.

## Примеры (равномерная выборка до 10 записей из POT)

### `dialog` — 7352 в POT, проза 6187

- `"COCK", hmm. Let's see.` — `speaker:Zoey`
- `(Is this really... okay...?)` — `speaker:Zoey`
- `(What... Was... That...?)` — `speaker:Zoey`
- `Break, hm? I think you need to be... physically examined... for suspici…` — `speaker:Enforcer`
- `Hah! Spooked ya!` — `ui`
- `I'm waiting.` — `speaker:Rugnar`
- `Mhmm... that's a good one...` — `speaker:Customer`
- `Perfect for... penetrative maintenance!` — `ui`
- `That sounds like a blast!` — `ui`
- `What is this place?` — `ui`

### `bundle` — 16 в POT, проза 9

- `A dick.` — `ui`
- `A pussy.` — `ui`
- `Cocky` — `speaker-name`
- `Lewd` — `speaker-name`
- `Nail Salon Clerk` — `speaker:Cocky`
- `Nail Salon Clerk` — `speaker:Mewing`
- `Nail Salon Clerk` — `speaker:Scheming`
- `Scheming` — `speaker-name`
- `U-Uhm... maybe a uh... a penis? Hypothetically of course...` — `ui`
- `Yeah, the customer decides, hun~` — `ui`

### `field:ArtistName` — 3 в POT, проза 0

- `Inspy Art` — `ui`
- `LenChi` — `ui`
- `STOAN` — `ui`

### `field:ArtistURL` — 1 в POT, проза 0

- `Anduo Games` — `ui`

### `field:Bind` — 0 в POT, проза 0

- (нет записей в POT)

### `field:DisplayName` — 41 в POT, проза 3

- `Andro knee` — `ui`
- `Bodywriting - Tallymark Back Thigh` — `ui`
- `Bruising` — `ui`
- `Collar` — `ui`
- `Drenched Pussy` — `ui`
- `Jewellery` — `ui`
- `Nails` — `ui`
- `Robotic Leg` — `ui`
- `Sticky Thighs` — `ui`
- `Swollen Pussy` — `ui`

### `field:FadeOutBoolName` — 1 в POT, проза 0

- `Fadeout` — `ui`

### `field:Name` — 15 в POT, проза 5

- `Basic Memory Card` — `ui`
- `Cozy Shorts` — `ui`
- `Femboy Bunnysuit Jay` — `ui`
- `Hello Gorgeous Bottom` — `ui`
- `Hi-Thread Croptop` — `ui`
- `Hi-Thread Shorts` — `ui`
- `Lio Default Bottom` — `ui`
- `Novas Outfit` — `ui`
- `Rosie Placeholder` — `ui`
- `Skank` — `ui`

### `field:ItemName` — синтетическая метка (2026-11-24)

Не имя поля type tree: так помечается **название предмета**, которое в raw-куче
игры идёт сразу за своим id `Apl_<…>` (база предметов в `resources`). Правило
структурное, поэтому скобки и длина не мешают: «Sporty Bra (Black)»,
«Leather Skirt (Black)» и ещё 60 названий раньше не попадали в POT — их резала
эвристика `(...)`, а парные копии из бандлов выпадали вместе с исключённым
`field:Name`. Правило действует только на `MonoBehaviour`: у `Sprite` в кучу
попадают соседние, но чужие строки (имя атласа, обрывок).
Замер: `potgen` даёт +79 записей, −0; TS↔Rust байт-в-байт.

### `field:TakenFromInventoryText` — 1 в POT, проза 0

- `Lost` — `ui`

### `field:UnknownName` — 1 в POT, проза 0

- `Salon Clerk` — `ui`

### `field:UseText` — 1 в POT, проза 0

- `Use` — `ui`

### `field:boneName` — 27 в POT, проза 2

- `FM_back` — `ui`
- `L_dick` — `ui`
- `N_foot` — `ui`
- `N_leg_back2` — `ui`
- `N_ponytail7` — `ui`
- `N_torso_front` — `ui`
- `Z_eyelidL` — `ui`
- `Z_ponytail8` — `ui`
- `Z_tongue7` — `ui`
- `man front left_IK` — `ui`

### `field:category` — 1 в POT, проза 0

- `General` — `ui`

### `field:fsm` — 18 в POT, проза 0

- `Inspection_Lio_Crotch` — `ui`
- `LioInspection_Penis` — `ui`
- `OnAnyLatchUnlocked` — `ui`
- `OnInjectorPickedUp` — `ui`
- `SuitcaseMinigame` — `ui`
- `entered` — `ui`
- `exited` — `ui`
- `open` — `ui`
- `stat_perversion` — `ui`
- `unlocked` — `ui`

### `field:m_AssemblyName` — 1 в POT, проза 0

- `Assembly-CSharp` — `ui`

### `field:m_AtlasTags` — 19 в POT, проза 14

- `Cartel Bad End Pinup` — `ui`
- `Corrupt Technologies Sex Ad` — `ui`
- `Cypher Fingering` — `ui`
- `Glowing Zoey - Anonymous Blowjob` — `ui`
- `Lio - A close friend` — `ui`
- `Nova - BunnyBouncer` — `ui`
- `Sarah - Pixel Portrait` — `ui`
- `Sarah Stomach Bulge` — `ui`
- `Tab Menu Atlas - General Menu Sprites` — `ui`
- `Zoey Boobflash CG - Sprite Atlas` — `ui`

### `field:m_ClassName` — 46 в POT, проза 0

- `ANBindDisplay` — `ui`
- `Camera` — `ui`
- `FootstepGroup` — `ui`
- `Light2D` — `ui`
- `NewMission` — `ui`
- `Outline` — `ui`
- `ScrollRect` — `ui`
- `SoftMask` — `ui`
- `SpriteGroupFade` — `ui`
- `TextMeshProUGUI` — `ui`

### `field:m_FontNames` — 3 в POT, проза 0

- `Ethnocentric` — `ui`
- `Orbitron` — `ui`
- `Play` — `ui`

### `field:m_Name` — 925 в POT, проза 366

- `0 - no arms` — `ui`
- `Background for AD cutscene` — `ui`
- `Dark Head Overlay` — `ui`
- `Injector Hitbox` — `ui`
- `LiquidDrip_005` — `ui`
- `NeonNights Mixer` — `ui`
- `PortraitZoey_6` — `ui`
- `Scroll View` — `ui`
- `Sweatline 7 #0` — `ui`
- `Zoey and Sarah Doggy 2` — `ui`

### `field:m_Namespace` — 3 в POT, проза 0

- `ANToolkit` — `ui`
- `EPOOutline` — `ui`
- `TMPro` — `ui`

### `field:m_PackedSpriteNamesToIndex` — 81 в POT, проза 35

- `Ad - Corrupt Technologies 3 - 1` — `ui`
- `Anduogames10v1` — `ui`
- `AssNude - 1 hand squeeze` — `ui`
- `Category Button Foreground` — `ui`
- `Cypher & Max - Beach Bums 4` — `ui`
- `Hello Gorgeous - 1` — `ui`
- `Leona Femdomming 3` — `ui`
- `Max & Cypher Bodywriting 1` — `ui`
- `Sarah Boo 3` — `ui`
- `Thighgrope Impact` — `ui`

### `field:m_text` — 9 в POT, проза 2

- `Back` — `ui`
- `Lock` — `ui`
- `May 2025` — `ui`
- `Move the camera to focus on targets` — `ui`
- `Nipples` — `ui`
- `OTHER` — `ui`
- `Suitcase Bad End` — `ui`
- `Tube` — `ui`
- `picture mode` — `ui`

### `field:slotName` — 1 в POT, проза 0

- `R_dick_front` — `ui`

### `settings` — 78 в POT, проза 21

- `Always Sprint` — `ui`
- `Dialogue Autoplay` — `ui`
- `Enable V Sync` — `ui`
- `Game Tab` — `ui`
- `Lovense Enabled` — `ui`
- `Lovense User Interface` — `ui`
- `Medium` — `ui`
- `Resolution` — `ui`
- `Slow` — `ui`
- `Use Joystick Axis Input` — `ui`

### `us` — 897 в POT, проза 576

- `! Was the mission ScriptableObject removed or the ID changed?` — `ui`
- `Attaching exit room!` — `ui`
- `Culled Lights` — `ui`
- `Frame Counter` — `ui`
- `Is Private` — `ui`
- `Master/Sounds Ducker/Sounds/Sex Sounds` — `ui`
- `Object is Destroyed` — `ui`
- `Render Glitch1 Effect` — `ui`
- `Show/Hide Declared Members` — `ui`
- `Too many arguments` — `ui`

### `raw:AnimationClip` — 1911 в POT, проза 87

- `!Z=I` — `ui`
- `@ ;IA` — `ui`
- `B:a` — `ui`
- `DHv` — `ui`
- `Ga2` — `ui`
- `Ih7` — `ui`
- `Lw4` — `ui`
- `P~?ff` — `ui`
- `Strike 7` — `ui`
- `WCUU` — `ui`

### `raw:Animator` — 1 в POT, проза 0

- `OY7?~` — `ui`

### `raw:AnimatorController` — 686 в POT, проза 154

- `"ZI` — `ui`
- `Boob squeeze` — `ui`
- `Default Idle` — `ui`
- `Eyes Ahegao` — `ui`
- `HalloweenPopup` — `ui`
- `Leona Mouth Sad` — `ui`
- `NonLewd` — `ui`
- `Rings 1` — `ui`
- `Tentacle Grope - Nose Pulling` — `ui`
- `Xwf` — `ui`

### `raw:AnimatorOverrideController` — 5 в POT, проза 0

- `Background_Up` — `ui`
- `Door_Apartment` — `ui`
- `Door_Side` — `ui`
- `Door_Single` — `ui`
- `Door_Wardrobe` — `ui`

### `raw:AssetBundle` — 136 в POT, проза 0

- `#O$5W` — `ui`
- `AR0` — `ui`
- `AW|&` — `ui`
- `ELM` — `ui`
- `I!l` — `ui`
- `K4g` — `ui`
- `NGbV` — `ui`
- `Qqm` — `ui`
- `U!m` — `ui`
- `Wbr'` — `ui`

### `raw:AudioClip` — 1536 в POT, проза 794

- `! Rosie said it` — `ui`
- `105-_color=perversion_Mnh.. Yes.. Ma'am..__color_` — `ui`
- `1384-Can you take a look at this headset for me_` — `ui`
- `20-Found Me` — `ui`
- `294-Uhh-! Nice tentacles!` — `ui`
- `46-Ghh~ Right ther- Ahh~! Ohh fffhh~` — `ui`
- `85-Huh_ What the hell is a crush_` — `ui`
- `NPCVA_FNPC2-Angry-Eh 0` — `ui`
- `PM_FSSF2_MICROTECH_3` — `ui`
- `VAZoey - 174 - Too fire I get it 2` — `ui`

### `raw:AudioMixerController` — 31 в POT, проза 12

- `BarMusic` — `ui`
- `E2SG` — `ui`
- `Glowing Hole Outside Bar Sounds - Inside` — `ui`
- `Glowing Hole Outside Bar Sounds - Outside - VADuck` — `ui`
- `MainMusic` — `ui`
- `Muffled behind Door VA` — `ui`
- `Pinup Video Booster` — `ui`
- `Sex Scene VA` — `ui`
- `Sounds Ducker` — `ui`
- `Uk8` — `ui`

### `raw:AudioMixerGroupController` — 2 в POT, проза 0

- `A?V` — `ui`
- `Cip` — `ui`

### `raw:AudioSource` — 4 в POT, проза 0

- `-IA` — `ui`
- `Qc@` — `ui`
- `VFr` — `ui`
- `Yg'` — `ui`

### `raw:BoxCollider` — 112 в POT, проза 0

- `"WA` — `ui`
- `/LA` — `ui`
- `A"n` — `ui`
- `A\S` — `ui`
- `E=v` — `ui`
- `Ha=8t` — `ui`
- `LA23` — `ui`
- `P?JA` — `ui`
- `Ru=P` — `ui`
- `XPI@` — `ui`

### `raw:Camera` — 1 в POT, проза 0

- `AX9` — `ui`

### `raw:CanvasRenderer` — 2 в POT, проза 0

- `AR\` — `ui`
- `ARsu` — `ui`

### `raw:ComputeShader` — 55 в POT, проза 6

- `;AB` — `ui`
- `BitonicSort4096` — `ui`
- `CopyToBuffer` — `ui`
- `DXBCe3nT@` — `ui`
- `MergeFinalPass` — `ui`
- `Result` — `ui`
- `SHEX8` — `ui`
- `SHEX`` — `ui`
- `SurfaceClosing` — `ui`
- `[VFX_WaterDrop] [Drop] Initialize Particle` — `ui`

### `raw:CustomRenderTexture` — 1 в POT, проза 1

- `Gallery Video Render Texture` — `ui`

### `raw:Font` — 44200 в POT, проза 22

- `! $n+Nl` — `ui`
- `3wyl' %jyy` — `ui`
- `BQ/4t(+sTKK` — `ui`
- `E^O_vv` — `ui`
- `I OR` — `ui`
- `Kzz` — `ui`
- `O9B6O[` — `ui`
- `R;c` — `ui`
- `UUt^` — `ui`
- `XoUlxx` — `ui`

### `raw:GameObject` — 6958 в POT, проза 1719

- `---------- UNFINISHED ------------` — `ui`
- `Boob Front` — `ui`
- `Collider below stairs bottom` — `ui`
- `Drum_Shadow` — `ui`
- `Gravestone Left` — `ui`
- `Levers` — `ui`
- `NeonSign_Lips` — `ui`
- `Rabbit` — `ui`
- `Spiral` — `ui`
- `Tunnel Stairs Top Visual` — `ui`

### `raw:Material` — 252 в POT, проза 144

- `3d Ad - Calliach 1` — `ui`
- `Bark_Effect` — `ui`
- `Flower Material 5` — `ui`
- `Light Bridge Horizontal` — `ui`
- `NTR 1 Ad - FakeLightMaterial` — `ui`
- `Orbitron-Regular Atlas Material` — `ui`
- `Shader Graphs_3d Flower 2d Shader` — `ui`
- `Shader Graphs_PerversionGaugeBarBG` — `ui`
- `Shader Graphs_Vertical Shape Fade Shader` — `ui`
- `TMPro/Sprite` — `ui`

### `raw:Mesh` — 10625 в POT, проза 2

- `!$HA"$$$IA%$` — `ui`
- `=F7I=)` — `ui`
- `AK|` — `ui`
- `C(?Ew` — `ui`
- `FF?r` — `ui`
- `I^A` — `ui`
- `MG=O` — `ui`
- `PnJ` — `ui`
- `TO?;` — `ui`
- `X8f3A` — `ui`

### `raw:MeshFilter` — 2 в POT, проза 0

- `ARB` — `ui`
- `AR]V` — `ui`

### `raw:MonoBehaviour` — 8461 в POT, проза 3239

- `""JO` — `ui`
- `BeenSoLong` — `ui`
- `Dialogue 3` — `ui`
- `Female Enforcer #1112` — `ui`
- `Injector Pop Out` — `ui`
- `Mmmh~` — `ui`
- `Play Groping Animation` — `ui`
- `Selected Waitressing Character` — `ui`
- `TOOL - TERTIARY ACTION` — `ui`
- `Wait for finish` — `ui`

### `raw:MonoScript` — 2887 в POT, проза 2

- `+DE` — `ui`
- `CC_Preset_Body` — `ui`
- `DisabledMetrics` — `ui`
- `GenericSum` — `ui`
- `IGraphDebugData` — `ui`
- `Locale` — `ui`
- `OrHandler` — `ui`
- `Resources` — `ui`
- `Skeleton` — `ui`
- `TypeExt` — `ui`

### `raw:ParticleSystem` — 3 в POT, проза 0

- `J?zv` — `ui`
- `Vv?u` — `ui`
- `]IF@]IF@` — `ui`

### `raw:PhysicMaterial` — 1 в POT, проза 1

- `Slutbox Physics Material` — `ui`

### `raw:RectTransform` — 94 в POT, проза 0

- `' D=JpD` — `ui`
- `?T3#A` — `ui`
- `A]m` — `ui`
- `B0a` — `ui`
- `BffH` — `ui`
- `CDq=4B` — `ui`
- `DNu` — `ui`
- `HDm` — `ui`
- `Oe?|` — `ui`
- `U_D` — `ui`

### `raw:RenderTexture` — 7 в POT, проза 3

- `BugReportRobo` — `ui`
- `CutIn RenderTexture` — `ui`
- `FakeMirror Preview RenderTexture` — `ui`
- `Flower RenderTexture` — `ui`
- `New Render Texture` — `ui`
- `Spine Dialogue Character Rendertexture` — `ui`
- `UIEffectRT` — `ui`

### `raw:Shader` — 1738 в POT, проза 190

- `!POSITION` — `ui`
- `Bokeh Depth Of Field CoC` — `ui`
- `EDITOR_VISUALIZATION` — `ui`
- `HIGH_QUALITY_DILATE` — `ui`
- `Ll) J` — `ui`
- `Opacity Front` — `ui`
- `S4o` — `ui`
- `Shader Graphs/Lightbridge` — `ui`
- `Sxw` — `ui`
- `USE_NORMAL_MAP` — `ui`

### `raw:ShaderVariantCollection` — 3 в POT, проза 0

- `SOFTMASKABLE UNDERLAY_ON` — `ui`
- `SOFTMASKABLE UNITY_UI_ALPHACLIP` — `ui`
- `ShaderVariants` — `ui`

### `raw:SkinnedMeshRenderer` — 5 в POT, проза 0

- `ARUTs` — `ui`
- `ARVX` — `ui`
- `ARf` — `ui`
- `Bv!?` — `ui`
- `Z?t)6?` — `ui`

### `raw:SphereCollider` — 2 в POT, проза 0

- `Gc=` — `ui`
- `PTA` — `ui`

### `raw:Sprite` — 4573 в POT, проза 37

- `!""?TUU?` — `ui`
- `?TUU` — `ui`
- `Afff?33` — `ui`
- `D-r` — `ui`
- `G@ff` — `ui`
- `Jz@H` — `ui`
- `NE5d&D` — `ui`
- `Qj1A` — `ui`
- `UkK@` — `ui`
- `Xx^` — `ui`

### `raw:SpriteAtlas` — 613 в POT, проза 3

- `!E43)B` — `ui`
- `8WE` — `ui`
- `BR_LE` — `ui`
- `CtHHD` — `ui`
- `DeC` — `ui`
- `F)E` — `ui`
- `L;i` — `ui`
- `PGE` — `ui`
- `UD!HgBd` — `ui`
- `XlE` — `ui`

### `raw:SpriteRenderer` — 124 в POT, проза 0

- `"5A?"5A?"5A?` — `ui`
- `;EB@` — `ui`
- `ARr` — `ui`
- `Cj?` — `ui`
- `G?ff` — `ui`
- `Hm:?` — `ui`
- `LAff` — `ui`
- `Q8?ff` — `ui`
- `SA\` — `ui`
- `WR^@s%` — `ui`

### `raw:SpriteShapeRenderer` — 30 в POT, проза 0

- `)AT` — `ui`
- `@:GBA` — `ui`
- `AAyS` — `ui`
- `BAF` — `ui`
- `E@j)` — `ui`
- `F|e?T` — `ui`
- `IT-` — `ui`
- `K!A` — `ui`
- `NAZ` — `ui`
- `X@c` — `ui`

### `raw:TextAsset` — 45030 в POT, проза 405

- `! ;\3r)B` — `ui`
- `A!X` — `ui`
- `Ak%` — `ui`
- `B_c` — `ui`
- `CMrPBu` — `ui`
- `Dl78Bj` — `ui`
- `I)HCc` — `ui`
- `N?:s` — `ui`
- `SBj` — `ui`
- `XOA` — `ui`

### `raw:Texture2D` — 3109 в POT, проза 132

- `! #.9EQ]gu` — `ui`
- `"-6?EJKOOOOOOGE@91'` — `ui`
- `$)05;AFGHFB;3)` — `ui`
- `%0;DMRT\\\\\\\\\XVQI?4)` — `ui`
- `&0@JRWZ```````][UMC5+!` — `ui`
- `'2=GOTV^^^^VTNF=2'` — `ui`
- `)2:AFGIHC=3-&` — `ui`
- `+4=CHISSSSSSSSSRHFB;3)` — `ui`
- `Hierarchy` — `ui`
- `Vertical Fade Both` — `ui`

### `raw:Transform` — 1105 в POT, проза 0

- `!A Z` — `ui`
- `=EO` — `ui`
- `A)\7A` — `ui`
- `A\%Y@` — `ui`
- `B33s` — `ui`
- `Dy?` — `ui`
- `IBf` — `ui`
- `NB@r` — `ui`
- `QhA` — `ui`
- `WoB~` — `ui`

### `raw:VideoClip` — 1 в POT, проза 1

- `Video - Zoeys Introduction Videor` — `ui`

### `raw:VisualEffect` — 10 в POT, проза 2

- `Impact` — `ui`
- `Impact Size Range` — `ui`
- `ImpactColor` — `ui`
- `Lifetime` — `ui`
- `OnPlay` — `ui`
- `RainTintColor` — `ui`
- `Random Spawn Offset` — `ui`
- `Rate` — `ui`
- `Wind Directio_direction` — `ui`
- `Wind Speed` — `ui`

### `raw:VisualEffectAsset` — 14 в POT, проза 0

- `A_a` — `ui`
- `Alpha_a` — `ui`
- `Color_a` — `ui`
- `Force_a` — `ui`
- `Force_b` — `ui`
- `OnStop` — `ui`
- `Rate'` — `ui`
- `Rate9` — `ui`
- `Scale_y_a` — `ui`
- `Spawn system` — `ui`

## `global` — кандидаты, которые инвентарь не читает

- уникальных строк в `global_strings`: **57539**; из них в POT (любым путём): **11803**; похожих на прозу: 4034.

Примеры (уже в POT через другой источник):

- `Create Main Menu Script`
- `New Game Animation Container`
- `Neck Button Area`
- `Bind Display for Selectable Variant`
- `Main Area Background`
- `Head Pat Button Area`
- `Bind Display for Selectable`
- `Bug Report Button`
- `Start Game Button`
- `Version Number Text`

## Связи

- `tasks/2026-11-22-pot-provenance.md` — постановка (этот шаг).
- `tasks/2026-11-22-pot-ui-filter-narrowing.md` — политика отбора по провенансу
  (следующий шаг; здесь ничего не исключено).
- `docs/pot-contract.md` — инвариант 14 (`#. src:`), спецификация метки.
- `docs/pot-coverage-audit.md` — что не доходит до POT (другой срез: покрытие).
- `scripts/pot_provenance_report.mts` — генератор таблиц этого документа.

> Обновление 2026-11-24: TS-эталоны удалены, рабочая реализация — Rust,
> паритет проверяется золотыми фикстурами (см. `docs/rust-vs-ts.md`, раздел 8).
