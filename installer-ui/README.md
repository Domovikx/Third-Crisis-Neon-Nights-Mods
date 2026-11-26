# NeonTranslatorDX Manager

Один exe для Windows 10/11 (Tauri 2: Rust-бэкенд + React 19 + StyleX) — это
**менеджер мода**, а не «инсталлятор + удалятор». Он находит игру в Steam,
показывает состояние мода и из одного окна ставит, обновляет, проверяет и
удаляет перевод. Ручной путь — `.7z` с той же раскладкой, **без exe и скриптов**;
манифест создаёт сам рантайм при первом запуске игры, поэтому оба способа
удаляются одинаково.

## Поток

```text
Статус (игра найдена/нет, мод стоит/нет, версия, активный язык, целостность)
  ├─ Установить      (если не установлен)
  ├─ Обновить        (если установлен; показывается «доступно обновление»)
  ├─ Проверить       (sha256 каждого файла манифеста)
  └─ Удалить         (только своё, при совпадении sha256, + пустые папки)
```

Выбора языков нет (решение протокола): payload несёт словари всех 10 языков,
`active_lang.txt` пишется как `ru`, язык переключается в меню мода. При
обновлении активный язык сохраняется, если его словарь остался в пакете.

## Раскладка

```text
<игра>/dwmapi.dll                    лоадер, единственный файл вне папки
<игра>/mods/NeonTranslatorDX/
  NeonTranslatorDX.dll
  fonts/*.ttf + typography.json
  patch_<lang>.dat                   все языки сразу (10)
  active_lang.txt
  install-manifest.json              файл, размер, sha256, версия пакета
```

Файлы игры не изменяются и не удаляются: `uninstall` трогает только пути из
манифеста (`dwmapi.dll`, `mods/NeonTranslatorDX/**`, `install.ps1`,
`README-INSTALL.md` из ручного архива) и только при совпадении sha256, плюс
собственные файлы рантайма в папке мода (`NeonTranslatorDX.log`,
`dump_GUIDictionary.json`, `nolog.txt`, `dwmapi_real.dll`).

Манифест (контракт v1, общий для менеджера и рантайма):

```json
{
  "version": 1,
  "payloadVersion": "2026.11.26-1",
  "lang": "ru",
  "installedAt": "2026-11-26T10:00:00.000Z",
  "files": [{ "path": "dwmapi.dll", "size": 13824, "sha256": "…" }]
}
```

Rust-парсер принимает и массив, и одиночный объект (PowerShell схлопывает
`@(x)`) и снимает UTF-8 BOM — иначе установка из старого `install.ps1` не
удалялась бы.

## Команды (Rust)

- `status_mod(game_dir)` — установлен ли мод, версия пакета, язык, число файлов,
  краткая целостность (`ok` / `missing` / `modified` / `broken` / `unknown`).
  Битый манифест не роняет статус: возвращается `broken` + `problem`.
  Каждый вызов пишет строку в `NeonTranslatorDXManager.log` (рядом с exe, иначе
  в `%TEMP%`).
- `install_mod` — свежая установка: копирует payload, пишет `active_lang.txt` и
  манифест (атомарно).
- `update_mod` — установка поверх: файлы заменяются только если sha256
  отличается (`copied`/`skipped`), исчезнувшие из пакета свои файлы удаляются
  (sha256 сверяется с прошлым манифестом), манифест перезаписывается атомарно.
  Прерванный прогон безопасно повторить — уже скопированное пропускается, так
  что повтор доводит установку до конца (идемпотентность).
- `uninstall_mod` — удаляет только своё (манифест + sha256 + пустые папки).
- `verify_mod` — сверка sha256 всех файлов манифеста.

CLI собранного exe (поддержка/E2E, без явного пути игру не ищет):

```bash
./target/debug/NeonTranslatorDXManager.exe --status "<папка игры>"
./target/debug/NeonTranslatorDXManager.exe --verify "<папка игры>"
./target/debug/NeonTranslatorDXManager.exe --install "<папка игры>" [lang]
./target/debug/NeonTranslatorDXManager.exe --update "<папка игры>"
./target/debug/NeonTranslatorDXManager.exe --uninstall "<папка игры>"
./target/debug/NeonTranslatorDXManager.exe --selftest [payload]
```

`--selftest` гоняет полный цикл во временной «игре»: install → status(ok) →
update меньшим payload (лишний файл удалён) → повторное обновление
(идемпотентно) → verify(ok) → uninstall(пусто). `--install` ставит из payload
бандла (язык по умолчанию `ru`), `--update` — поверх установленного.

## Дерево

```text
installer-ui/
  package.json, vite.config.ts, vitest.config.ts, tsconfig.json, index.html
  src/
    main.tsx, App.tsx, App.styles.ts, tokens.css
    i18n.ts                       ru/en, все строки; `en` типизирован ключами ru
    core/
      types.ts                    контракт с Rust (camelCase)
      flow.ts                     reducer экранов (чистый, тестируется)
      format.ts                   байты/путь/код языка
    hooks/useManager.ts           связка reducer ↔ платформа (только эффекты)
    platform/                     tauri.ts / mock.ts / index.ts
    screens/                      Status, Progress, Done, Verify, Uninstall
    ui/                           Button/Panel/Note/ProgressBar/Row + StyleX
  scripts/
    build_payload.mts             payload/ из артефактов репозитория или из архива
    build_manual_archive.mts      ручной .7z + README-INSTALL.md + fomod/ (без скриптов)
    make_icons.mts                исходный арт → icons/{icon.ico, *.png}
    manual_e2e.mts                E2E: распаковка → манифест рантайма → verify/uninstall
    manifest_harness.cs           консольный harness для реального ModManifest.cs
  core/                           Rust-ядро БЕЗ Tauri: detect/status/install/
                                  update/uninstall/verify
  src-tauri/                      тонкий слой: #[tauri::command] + прогресс + лог
```

## Сборка

Требования: Node 22+, Rust stable (MSVC), MSVC Build Tools, WebView2 Runtime,
7-Zip (только для payload из архива и для ручного `.7z`).

```bash
cd installer-ui
npm install
npm run payload                  # installer-ui/payload: лоадер + DLL + 10 словарей + шрифты
npm run icons                    # иконки из арта: src-tauri/icons/{icon.ico, *.png}
npm run tauri dev                # окно с hot-reload (или npm run dev — браузер на моке)
npm run tauri build              # NeonTranslatorDXManager.exe + NSIS в target/release/bundle
```

`npm run build` (tsc + vite) проверяет типы и собирает `dist/`, который Tauri
вшивает в бандл; `src-tauri/build.rs` следит за `dist/`, поэтому UI-правка
пересобирает exe (без этого cargo оставлял старый фронтенд — поймано 2026-11-25).

### Payload внутри бандла

Payload — **ресурс бандла**, а не папка «принеси с собой»:

```jsonc
// src-tauri/tauri.conf.json
"resources": { "../payload/": "payload/" }
```

- `tauri build` копирует `installer-ui/payload/` в `target/release/payload/`, а
  NSIS-инсталлятор кладёт `payload\…` в папку установки (проверено `7z l` по
  готовому setup.exe: 27 файлов, из них 20 — payload вместе с `payload.json`).
  Пользователь получает exe и пакет одним установщиком.
- Рантайм ищет payload в порядке: `<resource_dir>/payload` → `<exe_dir>/payload`
  → `resources/payload` → до 4 уровней вверх → `./payload`. Поэтому `cargo run`
  и `tauri dev` находят пакет без ручных копирований: tauri-build кладёт
  ресурсы в `target/<profile>/`, а в dev дополнительно работает путь
  `installer-ui/payload` из дерева репозитория.
- Для переносимой раздачи без инсталлятора: положить `payload/` рядом с exe
  (fallback, как раньше). Если payload не найден, UI честно пишет, что его нет.

### Иконки

Один исходный арт → `installer-ui/src-tauri/icons/`:

```bash
npm run icons -- --src ../tmp/icon-dx.jpg
```

`icon.ico` несёт 16/24/32/48/64/128/256 (все записи BMP 32 bpp: PNG внутри
`.ico` не читает, например, `System.Drawing.Icon`), плюс PNG 16…512 для
окна/сайта. Мелкие размеры (16/24) генерируются из центрального кадра без
внешней рамки — иначе рамка съедает глиф. Иконка окна на Windows берётся из
ресурса exe (`tauri-build` берёт `icons/icon.ico` из `bundle.icon`).

### Payload из архива

```bash
npm run payload -- --from ../dist/NeonTranslatorDX-v2026.11.26-manual.7z --version 2026.11.26-1
```

Из архива берутся только `dwmapi.dll` и `mods/NeonTranslatorDX/`; README и
`fomod/` игнорируются (у менеджера свой манифест).

### Ручной архив (Nexus-clean, без скриптов)

```bash
npm run manual -- --version 2026.11.26 --reuse
# → dist/NeonTranslatorDX-v2026.11.26-manual.7z
```

`--reuse` берёт уже собранный `installer-ui/payload` (важно, когда exe уже
вшил пакет версии `2026.11.26-1`: без `--reuse` payload перезапишется версией
архива). Внутри архива версия — дата релиза (`2026.11.26`), версия пакета
менеджера — `2026.11.26-1`.

Состав: `dwmapi.dll` + `mods/NeonTranslatorDX/…` (включая `active_lang.txt=ru`)

- `README-INSTALL.md` + `fomod/info.xml` + `fomod/ModuleConfig.xml`. **Ни одного**
  `.exe/.cmd/.ps1` — сканер Nexus такие архивы отправляет в карантин; состав
  проверяется до упаковки (`forbiddenEntries`), архив — `7z t`.

Установка = распаковать в папку игры. Манифест создаёт **сам рантайм**
(`ModManifest.cs`) при первом запуске: перечисляет файлы папки мода и лоадер с
sha256. Поэтому менеджер и `--uninstall` работают и для ручного пути, без
скрипта. Обновление = распаковать новый архив поверх: рантайм увидит, что
sha256 самой DLL в манифесте устарел, и пересоберёт манифест. Удаление =
удалить `dwmapi.dll` и `mods/NeonTranslatorDX/` (атомарно по папке) либо
«Удалить» в менеджере. Vortex ставит тот же архив через FOMOD.

`dwmapi.dll` — неизбежный лоадер (DLL-hijack): антивирус может ругаться на
подмену системной DLL, это известный паттерн, исходники прокси открыты
(`.opencode/skills/build-translator/source/dwmapi_proxy.c`). В README архива это
написано честно.

## Обновление payload (каждый релиз)

1. Пересобрать артефакты: `npm run build` (C# DLL) и `npm run po2dat -- <lang>`,
   при необходимости `npm run l10n:build`.
2. `cd installer-ui && npm run payload -- --version <YYYY.MM.DD-N>` — папка
   `payload/` перезаписывается целиком (версия = версия менеджера, напр.
   `2026.11.26-1`).
3. Проверить отчёт: число файлов, список языков (все 10), размер.
4. `npm run tauri build` — payload уедет в exe-бандл как ресурс. Для ручной
   раздачи без инсталлятора дополнительно положить `payload/` рядом с exe.
5. `npm run manual -- --version <YYYY.MM.DD> --reuse` — ручной Nexus-clean `.7z`.
6. Прогнать тесты и E2E (ниже): обновление обязано пережить меньший пакет и
   повторный запуск.

`payload.json` фиксирует версию, языки и дату сборки; статус сравнивает его
версию с `payloadVersion` манифеста и показывает «доступно обновление».

## Тесты

```bash
cd installer-ui
cargo test                       # Rust: detect/status/install/update/uninstall/verify
cargo clippy --all-targets       # линт Rust (0 предупреждений)
npm test                         # vitest: reducer, локали, экраны статуса/обновления, App
npm run build                    # tsc + vite (типы и StyleX)
node --test scripts/build_manual_archive.test.mts   # состав архива, запрещённые типы, FOMOD
node --test scripts/make_icons.test.mts             # контейнер .ico, BMP-запись
node scripts/manual_e2e.mts      # распаковка → манифест рантайма → verify/update/uninstall
```

Rust-тесты `update_mod`: замена/добавление/удаление файла и сходимость
состояния, повторный прогон (0 записей), докат после «обрыва» (файл уже
скопирован, манифест старый), сохранение языка и фолбэк при удалённом словаре.
`status_mod`: нет мода, стоит и цел, изменён/нет файлов, битый манифест.

### E2E на живой игре (приёмка MVP)

```powershell
$GAME = "C:\Program Files (x86)\Steam\steamapps\common\Third Crisis Neon Nights"
$MGR  = "installer-ui\target\release\NeonTranslatorDXManager.exe"

& $MGR --selftest                                   # временная «игра», реальную не трогает
node tmp/clean_room.mts snapshot "$GAME" tmp/e2e/clean.json
& $MGR --install "$GAME" ru                         # поставить менеджером
& $MGR --status "$GAME"                             # installed, version 2026.11.26-1, integrity ok
& $MGR --verify "$GAME"                             # 20/20, 0 нет, 0 изменено
& $MGR --uninstall "$GAME"                          # удалить только своё
node tmp/clean_room.mts snapshot "$GAME" tmp/e2e/after.json
node tmp/clean_room.mts diff tmp/e2e/clean.json tmp/e2e/after.json   # 0/0/0
```

`tmp/clean_room.mts` и `tmp/e2e_game.ps1` — вспомогательные скрипты приёмки
(временные, не часть продукта).

## Артефакты MVP (2026.11.26)

| Файл                                                       | Размер   | Что это                                                |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------ |
| `dist/NeonTranslatorDXManager.exe`                         | 4.84 MiB | менеджер (release, иконка, payload в ресурсах)         |
| `dist/NeonTranslatorDX Manager_2026.11.26-1_x64-setup.exe` | 5.38 MiB | NSIS-инсталлятор (опционально)                         |
| `dist/NeonTranslatorDX-v2026.11.26-manual.7z`              | 3.78 MiB | ручной архив, 23 файла, без `.exe/.cmd/.ps1`           |
| `dist/payload/`                                            | 20.3 MiB | пакет рядом с exe: `dist/*.exe` работает без установки |

Сборка артефактов повторяется командами из «Сборка» + `npm run manual --reuse`;
`dist/` — расходник, в git не идёт.

## Что подписывать

Подписывается **exe менеджера** (и NSIS-инсталлятор, если он распространяется):

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f certificate.pfx /p <пароль> `
  "target\release\NeonTranslatorDXManager.exe"
```

- Сертификат — OV/EV Code Signing; EV быстрее снимает SmartScreen, OV с
  накопленной репутацией тоже работает.
- Подпись не отменяет SmartScreen-предупреждение для нового издателя — это
  репутация, а не ошибка подписи.
- `dwmapi.dll` (прокси-лоадер) подписывать нечем и не нужно; антивирусы могут
  ругаться на DLL-hijack — ожидаемо, лечится README и отправкой false positive.
- Архив `.7z` не подписывается; публикуйте SHA-256 рядом с релизом.

## Скрипты корневого `package.json`

```json
"payload": "node installer-ui/scripts/build_payload.mts",
"manual": "node installer-ui/scripts/build_manual_archive.mts",
"manual:archive": "node installer-ui/scripts/build_manual_archive.mts",
"test:installer": "cd installer-ui && cargo test && npm test"
```

## Что осталось

- **Подпись exe/инсталлятора** (сертификат OV/EV) и проверка антивирусами —
  см. «Что подписывать». Без подписи SmartScreen предупреждает о новом издателе.
- **Иконка 16×16.** Арт «DX в неоновой рамке» читается с 24–32 px, а в 16×16
  (заголовок окна/список файлов) превращается в неоновое пятно: тонкие тёмные
  штрихи глифа съедаются при уменьшении. Нужен упрощённый знак для мелких
  размеров (толстые штрихи, без свечения/рамки) — или принять как есть.
- Обновление «по кнопке» из сети (сейчас — новый установщик/пакет).
- `--migrate` со старых раскладок (`Managed/`, `NeonTranslator/`).
- Портативный режим (папка мода вне игры) — по отзывам.
- `scripts/package_release.mts` — тонкая обёртка над `npm run manual` (все
  языки, 7z, без скриптов); старый single-lang zip с `install.ps1` удалён.
