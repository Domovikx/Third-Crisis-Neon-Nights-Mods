---
description: Deploy patch into the game via deploy.ps1 (Lang, Rebuild, Proxy flags)
agent: build
---

Run from the repository root (`Third-Crisis-Neon-Nights-Mods`). Pass through `$ARGUMENTS` verbatim.

> **Статус:** `deploy.ps1` починен после переезда — путь к игре берётся из
> `TCNN_GAME_DIR` (фолбэк — родитель репозитория), словарь собирает `po2dat.mts`.
> Сборка DLL/прокси пока Python (`build.py`/`build_proxy.py`, тот же env);
> полный `.mts`-порт — `tasks/2026-11-21-port-build-deploy.md`.

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 $ARGUMENTS
```

Flags (see `deploy.ps1` header + skill `deploy-translator`):

- `-Lang <code>` — language code, default `ru`; `de/es/pt/pl` drafted next.
  Compiles `po/<lang>.po` → `runtime/patch_<lang>.dat` via `po2dat.mts`.
- `-Rebuild` — rebuild `NeonTranslatorRuntime.dll` via
  `.opencode/skills/build-translator/scripts/build.py` before deploying.
- `-Proxy` — also rebuild `dwmapi.dll` via `build_proxy.py` (needs MSVC);
  resyncs the repo copy. Only meaningful together with `-Rebuild`.

What deploy does:

1. (optional) rebuild DLL (+ proxy)
2. `po2dat.mts <lang>` → `runtime/patch_<lang>.dat` (JSON-lines, untracked)
3. DLL + font (`fonts/RobotoCondensed-Regular.ttf`) + `patch_<lang>.dat` +
   `active_lang.txt` → `<game>/Third Crisis Neon Nights_Data/Managed/`
4. Removes legacy `<game>/translations/` YAML mirror
5. `dwmapi.dll` → game root (next to exe; Steam "verify integrity" removes
   it — just rerun this script)

Examples:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Lang de
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Rebuild
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Rebuild -Proxy
```

After deploy: restart the game, check
`<game>/Third Crisis Neon Nights_Data/Managed/NeonTranslator.log`.
