# NeonTranslatorDX — установщик (v1)

Один установщик для Windows 10/11 на Tauri 2 (Rust-бэкенд + React 19 + StyleX):
находит игру в библиотеках Steam, ставит перевод, пишет манифест установки,
умеет проверить целостность и удалить ровно поставленное. Ручной путь — `.7z`
с той же раскладкой и `install.ps1`, который пишет **тот же** манифест.

Второй способ установки (браузерный, File System Access API) снят: см.
`tasks/2026-11-24-installer-protocol.md`.

## Раскладка

```text
<игра>/dwmapi.dll                    лоадер, единственный файл вне папки
<игра>/mods/NeonTranslatorDX/
  NeonTranslatorDX.dll
  fonts/*.ttf + typography.json
  patch_<lang>.dat                   все языки сразу (10)
  active_lang.txt                    стартовый язык (ru; переключение — в меню мода)
  install-manifest.json              файл, размер, sha256 — для удаления/проверки
```

Файлы игры не изменяются и не удаляются: `uninstall` трогает только пути из
манифеста (`dwmapi.dll`, `mods/NeonTranslatorDX/**`, `install.ps1`,
`README-INSTALL.md` из ручного архива) и только при совпадении sha256, плюс
собственные файлы рантайма в папке мода (`NeonTranslatorDX.log`,
`dump_GUIDictionary.json`, `nolog.txt`, `dwmapi_real.dll`).
Пустые `fonts/`, папка мода и `mods/` удаляются; непустые — остаются.

Манифест (контракт v1, общий для exe и `install.ps1`):

```json
{
  "version": 1,
  "lang": "ru",
  "installedAt": "2026-11-25T10:00:00.000Z",
  "files": [{ "path": "dwmapi.dll", "size": 13824, "sha256": "…" }]
}
```

Выбора языков в установщике нет (решение протокола): пакет кладёт словари всех
10 языков сразу, `active_lang.txt` пишется как `ru`, а язык игрок переключает в
меню мода. Отдельные пакеты появятся только если/когда будет озвучка.

Rust-парсер принимает и массив, и одиночный объект (PowerShell схлопывает
`@(x)`) и снимает UTF-8 BOM — иначе установка из старого `install.ps1` не
удалялась бы.

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
    hooks/useInstaller.ts         связка reducer ↔ платформа (только эффекты)
    platform/
      tauri.ts                    invoke/listen/dialog
      mock.ts                     мок для `npm run dev` и SSR-тестов
      index.ts                    выбор транспорта
    screens/                      Welcome, Detect, Installing, Done, Uninstall, Verify
    ui/                           Button/Panel/Note/ProgressBar/Row + StyleX
  scripts/
    build_payload.mts             payload/ из артефактов репозитория или из архива
    build_manual_archive.mts      ручной .7z + install.ps1 + README-INSTALL.md
  core/                           Rust-ядро БЕЗ Tauri: detect/install/uninstall/verify
  src-tauri/                      тонкий слой: #[tauri::command] + прогресс-события
```

Логика — порт `deploy.mts` без Node: план копирования заменён готовым payload'ом
(`payload/` собирается заранее), `build-dat` и `--migrate` в v1 не входят
(словари уже в payload; миграция старых раскладок — задача на после релиза).

## Сборка

Требования: Node 22+, Rust stable (MSVC), MSVC Build Tools, WebView2 Runtime,
7-Zip (только для payload из архива и для ручного `.7z`).

```bash
cd installer-ui
npm install
npm run payload                  # installer-ui/payload: лоадер + DLL + 10 словарей + шрифты
npm run tauri dev                # окно с hot-reload (или npm run dev — браузер на моке)
npm run tauri build              # exe + NSIS-установщик в target/release/bundle
```

`npm run build` (tsc + vite) проверяет типы и собирает `dist/`, который Tauri
вшивает в бандл; `src-tauri/build.rs` следит за `dist/`, поэтому UI-правка
пересобирает exe (без этого cargo оставлял старый фронтенд — поймано 2026-11-25). Payload **не вшивается** в exe в v1: папка `payload/` лежит
рядом с exe. Для релиза: положить `payload/` в тот же каталог, что
`NeonTranslatorDX Installer.exe` (или добавить её в NSIS как resource — см.
«Что осталось»).

### Сборка payload из архива

```bash
npm run payload -- --from ../dist/NeonTranslatorDX-v2026.11.25-manual.7z --version 2026.11.25
```

Из архива берутся только `dwmapi.dll` и `mods/NeonTranslatorDX/`; `install.ps1`
и README архива игнорируются (у exe свой манифест).

### Ручной архив

```bash
npm run manual -- --version 2026.11.25
# → dist/NeonTranslatorDX-v2026.11.25-manual.7z
```

Архив собирается из того же `payload/`, кладёт `install.ps1` (пишет
`active_lang.txt` и манифест всех файлов) и `README-INSTALL.md`. Проверка
раскладки — до упаковки, целостность архива — `7z t`.

## Обновление payload (каждый релиз)

1. Пересобрать артефакты: `npm run build` (C# DLL) и `npm run po2dat -- <lang>`
   для языков, затем `npm run l10n:build`, если ещё не собран.
2. `cd installer-ui && npm run payload -- --version <YYYY.MM.DD>` — папка
   `payload/` перезаписывается целиком.
3. Проверить отчёт: число файлов, список языков (должны быть все 10), размер.
4. Положить `payload/` рядом с exe (или пересобрать архив `npm run manual`).
5. Проверить установку/удаление: `cargo test`, `npm test`, затем E2E ниже.

`payload.json` внутри папки фиксирует версию, языки и дату сборки — установщик
показывает их на приветственном экране.

## Тесты

```bash
cd installer-ui
cargo test                       # Rust: detect/install/uninstall/verify (временные папки)
npm test                         # vitest: reducer, локали, экраны (SSR), App
npm run build                    # tsc + vite (типы и StyleX)
```

E2E собранного бинаря (в реальную игру не пишет):

```bash
# установка во временную «игру» → verify → uninstall → проверка «пусто»
./target/debug/neon-installer.exe --selftest "$PWD/payload"

# ручной путь: распаковать архив в тестовую папку с маркерами игры
./target/debug/neon-installer.exe --verify "<тестовая папка>"
./target/debug/neon-installer.exe --uninstall "<тестовая папка>"
```

`--verify`/`--uninstall` — поддержка и E2E; без явного пути они игру не ищут.

## Что подписывать

Подписывается **exe установщика** (и NSIS-инсталлятор, если он распространяется):

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f certificate.pfx /p <пароль> `
  "target\release\NeonTranslatorDX Installer.exe"
```

- Сертификат — OV/EV Code Signing; EV быстрее снимает SmartScreen, но OV с
  накопленной репутацией тоже работает.
- Подпись не отменяет SmartScreen-предупреждение для нового издателя — это
  репутация, а не ошибка подписи.
- `dwmapi.dll` (прокси-лоадер) подписывать нечем и не нужно; антивирусы могут
  ругаться на DLL-hijack — это ожидаемо, лечится описанием в README и
  отправкой false positive вендору, а не «пересборкой».
- Архив `.7z` не подписывается; публикуйте SHA-256 рядом с релизом.

## Строки для корневого `package.json` (не добавлены)

```json
"payload": "node installer-ui/scripts/build_payload.mts",
"manual:archive": "node installer-ui/scripts/build_manual_archive.mts",
"test:installer": "cd installer-ui && cargo test && npm test"
```

(Корневой `package.json` в этой задаче не менялся — строки на согласование.)

## Что осталось

- Полировка дизайна (v1 намеренно без неё): иконки сейчас **плейсхолдер**
  (взяты из TSSR-установщика), нужен свой знак.
- Вшить `payload/` в NSIS-бандл (resource) вместо папки рядом с exe.
- Обновление «по кнопке»: проверка новой версии и замена файлов (сейчас —
  переустановка поверх; лишние файлы прошлого пакета удаляются по sha256).
- `--migrate` со старых раскладок (`Managed/`, `NeonTranslator/`) — в v1 нет.
- Подпись и проверка антивирусов (см. выше).
- Выбор «портативного режима» (папка мода вне игры) — по отзывам.
