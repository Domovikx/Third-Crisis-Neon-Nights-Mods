# NeonTranslatorDX — установка без exe

Версия архива: {{VERSION}}

> **СТРОГО 18+.** Игра содержит откровенный контент; перевод передаёт его без цензуры.

В архиве **нет** `.exe`, `.cmd` и `.ps1` — только данные, шрифты, DLL перевода и
лоадер. Ничего запускать не нужно: установка — это распаковка. Этот же файл
лежит внутри архива (`README-INSTALL.md`).

## Что в архиве

| Путь                                         | Куда попадает                     |
| -------------------------------------------- | --------------------------------- |
| `dwmapi.dll`                                 | корень игры (лоадер)              |
| `mods/NeonTranslatorDX/NeonTranslatorDX.dll` | переводчик                        |
| `mods/NeonTranslatorDX/patch_<lang>.dat`     | словари всех языков (10 файлов)   |
| `mods/NeonTranslatorDX/fonts/`               | шрифты (латиница, кириллица, CJK) |
| `mods/NeonTranslatorDX/active_lang.txt`      | стартовый язык (`ru`)             |
| `README-INSTALL.md`                          | этот файл                         |
| `fomod/`                                     | для Vortex; вручную не нужен      |

## Установка (3 шага)

1. Распакуйте **весь** архив в папку игры — туда, где лежит
   `Third Crisis Neon Nights.exe`. Например:
   `C:\Program Files (x86)\Steam\steamapps\common\Third Crisis Neon Nights`.
2. Запустите игру **один раз**: рантайм сам создаст
   `mods\NeonTranslatorDX\install-manifest.json` (список файлов с sha256).
   Он нужен менеджеру и удалению; без него перевод всё равно работает.
3. Язык переключается в меню мода в игре.

Установка атомарна по папке: всё, кроме `dwmapi.dll`, лежит в
`mods\NeonTranslatorDX\`.

## Обновление

Распакуйте новый архив **поверх** (в ту же папку игры). Файлы заменятся, а
манифест рантайм пересоберёт при следующем запуске игры — по sha256 самой DLL
он увидит, что сборка новая. Ничего удалять руками не нужно.

## Удаление

Удалите два места (игра вернётся на английский):

- `<игра>\dwmapi.dll`
- папку `<игра>\mods\NeonTranslatorDX\` целиком (пустая `mods\` тоже удаляется)

Файлы `README-INSTALL.md` и `fomod\` в корне игры — из архива, их можно удалить.
Сохранения и файлы игры не затрагиваются.

Если установлен **NeonTranslatorDX Manager**, удаление проще: «Удалить» в окне
менеджера (он читает `install-manifest.json` и удаляет только своё). Если
менеджер пишет «не установлен» — запустите игру один раз, чтобы появился манифест.

## Vortex

«Install from file» с этим же архивом: `fomod/ModuleConfig.xml` раскладывает
`dwmapi.dll` и `mods/NeonTranslatorDX/` в корень игры. Отдельный FOMOD-архив не
нужен; ручная распаковка даёт тот же результат. FOMOD не содержит исполняемых
файлов.

## Про `dwmapi.dll`

`dwmapi.dll` — **лоадер** (подмена системной DLL, DLL-hijack): игра грузит его
раньше своих сборок, а он загружает `mods/NeonTranslatorDX/NeonTranslatorDX.dll`.
Другого способа внедрить перевод без правки файлов игры нет. Антивирус может
ругаться на «подмену системной DLL» — это известный паттерн, а не вирус;
исходники лоадера открыты (`dwmapi_proxy.c` в репозитории мода). Файлы игры при
этом не изменяются: Steam → «Проверить целостность» не перекачивает ничего,
кроме самого `dwmapi.dll` (его можно вернуть повторной распаковкой).

## English (short)

Extract the whole archive into the game folder (next to the game exe). Start the
game once: the runtime writes `mods/NeonTranslatorDX/install-manifest.json`
(file list with sha256) used by the manager and the uninstaller. Switch the
language in the in-game mod menu. Update: extract a newer archive over the same
folder (the manifest is rebuilt on the next launch). Uninstall: delete
`dwmapi.dll` and `mods/NeonTranslatorDX/`. No executable files are included;
`dwmapi.dll` is a loader (DLL-hijack) and may trigger antivirus heuristics —
the proxy sources are public in the mod repository.

## English (Vortex)

Install from file with this archive; `fomod/ModuleConfig.xml` places
`dwmapi.dll` and `mods/NeonTranslatorDX/` into the game root. Manual extraction
gives the same result.
