/**
 * Тексты лендинга NeonTranslatorDX — один словарь на два языка страницы.
 *
 * Сайт статический и двуязычный (ru — основная страница, en — en.html).
 * Разметка одна (`template.html`), тексты подставляются из этого файла, а
 * цифры (строки, разметка, покрытие) считаются из `po/` при сборке.
 * Добавили строку — добавьте её во ВСЕ языки: `Record<SiteMessageKey, string>`
 * не даст забыть (typecheck).
 */

const RU = {
  "meta.title": "NeonTranslatorDX — русский и ещё 9 языков для Third Crisis: Neon Nights",
  "meta.description":
    "Неофициальный текстовый перевод Third Crisis: Neon Nights на 10 языков. Оригинал не меняется, озвучка остаётся, язык переключается панелью по F9.",

  "nav.features": "Что переводится",
  "nav.languages": "Языки",
  "nav.shots": "Скриншоты",
  "nav.install": "Установка",
  "nav.faq": "FAQ",
  "nav.switch": "EN",
  "nav.switchTitle": "English version",
  "nav.label": "Разделы страницы",
  "nav.skip": "К содержанию",

  "hero.kicker": "Неофициальный перевод · Anduo Games",
  "hero.lead":
    "Русский и ещё девять языков для Third Crisis: Neon Nights. Текст подменяется в памяти игры: файлы игры не меняются, озвучка и графика остаются студийными.",
  "hero.badge.langs": "{langs} языков",
  "hero.badge.adult": "18+",
  "hero.badge.version": "v{version}",
  "hero.badge.text": "только текст",
  "hero.btn.exe": "Скачать (exe)",
  "hero.btn.manual": "Ручная установка (7z)",
  "hero.note":
    "Сборка {version}: архивы и установщик публикуются в GitHub Releases. Установщик (exe) готовится к релизу; ручной архив ставится за три шага.",

  "stats.label": "Покрытие перевода",
  "stats.lines": "строк на язык",
  "stats.rich": "строк с rich-разметкой",
  "stats.langs": "языков перевода",
  "stats.missing": "непереведённых строк",
  "features.title": "Что переводится",
  "features.lead":
    "Перевод идёт по текстовым данным игры: меню, диалоги, интерфейс, описания предметов и квестов. Картинки и звук не трогаем.",
  "features.menu.title": "Меню и интерфейс",
  "features.menu.text": "Главное меню, настройки, кнопки, подсказки и экраны загрузки.",
  "features.dialog.title": "Диалоги и нарратив",
  "features.dialog.text": "Реплики, мысли, описания сцен и предметов — весь сюжетный текст.",
  "features.rich.title": "Rich-разметка",
  "features.rich.text":
    "Курсив, цвет, размер и TMP-теги сохраняются: {rich} строк с разметкой собираются заново, а не теряются.",
  "features.fonts.title": "Шрифты и CJK",
  "features.fonts.text":
    "Roboto Condensed для латиницы и кириллицы, Noto Sans SC/JP/KR для китайского, японского и корейского. Глифы сверены с корпусом переводов.",
  "features.live.title": "Живое переключение",
  "features.live.text":
    "Панель языка открывается по F9; выбор пишется в active_lang.txt и применяется без перезапуска игры.",
  "features.safe.title": "Игра не меняется",
  "features.safe.text":
    "Рабочие файлы мода — только dwmapi.dll и папка mods/NeonTranslatorDX/. Steam-верификация не перекачивает файлы игры.",

  "languages.title": "Языки",
  "languages.lead":
    "Десять языков перевода плюс английский оригинал. Порядок — по языковой статистике Steam (config/language-priority.mts); покрытие считается из po/<lang>.po при каждой сборке.",
  "languages.cell": "{lines} строк · {pct}%",
  "languages.primary": "основной",
  "languages.source": "Английский — оригинал: словарь не нужен, игра запускается как есть.",

  "shots.title": "Скриншоты",
  "shots.lead": "Живая игра, не макеты: главное меню до и после, панель языка и проверка шрифтов.",
  "shots.menuEn": "Главное меню: английский оригинал",
  "shots.menuRu": "Главное меню: русский перевод",
  "shots.panel": "Панель языка по F9: английский оригинал и десять переводов",
  "shots.specimen": "Китайский, японский и корейский: 0 «тофу» на проверенных глифах",
  "shots.font": "Подбор шрифта: кириллица в меню игры",

  "install.title": "Установка",
  "install.lead":
    "Два пути — установщик (exe) и ручной архив. Оба дают одну и ту же раскладку, ставятся поверх и удаляются без следов.",
  "install.exe.title": "Установщик (exe)",
  "install.exe.text":
    "Найдёт игру в Steam, проверит версию, скопирует файлы и сможет удалять мод, не оставляя мусора. Готовится к релизу.",
  "install.exe.badge": "в разработке",
  "install.manual.title": "Ручная установка (7z)",
  "install.manual.text":
    "Распаковать архив в папку игры, запустить install.ps1, запустить игру. Подходит, если политика антивируса не любит exe.",
  "install.manual.link": "Скачать архив",
  "install.steps.title": "Три шага",
  "install.step1": "Купить и установить Third Crisis: Neon Nights в Steam.",
  "install.step2": "Распаковать архив в папку игры (рядом с exe игры) и запустить install.ps1.",
  "install.step3": "Запустить игру и открыть панель языка по F9.",
  "install.layout.title": "Что появится в папке игры",
  "install.layout.note":
    "Вне папки mods/NeonTranslatorDX/ — только загрузчик dwmapi.dll. При ручной установке рядом появляются install.ps1 и README-INSTALL.md; после установки их можно удалить.",
  "install.remove.title": "Удаление без следов",
  "install.remove.text":
    "Удалите dwmapi.dll и папку mods/NeonTranslatorDX/ (при ручной установке — ещё install.ps1 и README-INSTALL.md) — игра вернётся к английскому. Сохранения и файлы игры не затрагиваются. После Steam → «Проверить целостность» игра не перекачивает ни одного файла.",
  "install.steam.title": "Если Steam удалил dwmapi.dll",
  "install.steam.text":
    "Это ожидаемо: проверка целостности убирает файлы, которых нет в составе игры. Папка мода остаётся; повторно запустите install.ps1 или установщик — перевод снова на месте.",

  "faq.title": "Частые вопросы",
  "faq.av.q": "Антивирус ругается на dwmapi.dll. Это вирус?",
  "faq.av.a":
    "Нет. Это небольшой загрузчик перевода: он подхватывает NeonTranslatorDX.dll при старте игры и не ходит в сеть. Эвристика антивирусов иногда помечает подмену системной DLL. Добавьте папку игры в исключения, восстановите файл из архива и запустите install.ps1.",
  "faq.steam.q": "Steam удалил dwmapi.dll после проверки целостности. Что делать?",
  "faq.steam.a":
    "Проверка целостности стирает всё, чего нет в оригинальной игре, — это нормально и как раз доказывает, что файлы игры не меняются. Папка mods/NeonTranslatorDX/ обычно остаётся. Запустите install.ps1 ещё раз (или установщик) — файл вернётся.",
  "faq.switch.q": "Как переключить язык в игре?",
  "faq.switch.a":
    "Нажмите F9 или откройте панель языка из главного меню. Выбор применяется сразу и пишется в mods/NeonTranslatorDX/active_lang.txt. Английский — это native-режим без словаря.",
  "faq.logs.q": "Где логи?",
  "faq.logs.a":
    "В mods/NeonTranslatorDX/NeonTranslatorDX.log. При запуске там должны быть строки Lang: ru, source: ...patch_ru.dat и Translations: больше нуля. Если файла нет — загрузчик не подхватился.",
  "faq.exe.q": "Чем exe отличается от ручного архива?",
  "faq.exe.a":
    "Набор файлов один и тот же. Установщик сам найдёт игру, проверит версию и сможет удалять мод; ручной архив делает то же самое через install.ps1 и подходит для портативных установок.",

  "legal.title": "Правовая оговорка",
  "legal.text":
    "Неофициальный фанатский мод, не связанный с Anduo Games. Все права на игру и её контент принадлежат Anduo Games. Для использования нужна лицензионная копия. Контент 18+: перевод сохраняет взрослые сцены и лексику без цензуры и смягчений.",
  "links.title": "Ссылки",
  "links.github": "GitHub — исходники и релизы",
  "links.github.note": "Код пайплайна, задачи и сборки мода.",
  "links.nexus": "Nexus Mods",
  "links.nexus.note": "Страница мода на Nexus готовится к публикации.",
  "links.boosty": "Boosty — поддержать автора",
  "links.boosty.note": "Новости проекта и добровольная поддержка.",
  "links.kofi": "Ko-fi — поддержать автора",
  "links.kofi.note": "Альтернативный способ поддержки.",

  "footer.built":
    "Страница собрана {date}. Цифры пересчитаны из po/*.po при сборке, руками не правятся.",
} as const;

export type SiteMessageKey = keyof typeof RU;
export type SiteLang = "ru" | "en";

const EN: Record<SiteMessageKey, string> = {
  "meta.title": "NeonTranslatorDX — Russian and nine more languages for Third Crisis: Neon Nights",
  "meta.description":
    "Unofficial text translation of Third Crisis: Neon Nights into 10 languages. The game stays untouched, the original voice remains, and the language panel opens with F9.",

  "nav.features": "What is translated",
  "nav.languages": "Languages",
  "nav.shots": "Screenshots",
  "nav.install": "Install",
  "nav.faq": "FAQ",
  "nav.switch": "RU",
  "nav.switchTitle": "Русская версия",
  "nav.label": "Page sections",
  "nav.skip": "Skip to content",

  "hero.kicker": "Unofficial translation · Anduo Games",
  "hero.lead":
    "Russian and nine more languages for Third Crisis: Neon Nights. Text is replaced in memory: the game files stay untouched, and the original voice and art remain.",
  "hero.badge.langs": "{langs} languages",
  "hero.badge.adult": "18+",
  "hero.badge.version": "v{version}",
  "hero.badge.text": "text only",
  "hero.btn.exe": "Download (exe)",
  "hero.btn.manual": "Manual install (7z)",
  "hero.note":
    "Build {version}: archives and the installer are published on GitHub Releases. The (exe) installer is being prepared; the manual archive installs in three steps.",

  "stats.label": "Translation coverage",
  "stats.lines": "lines per language",
  "stats.rich": "lines with rich markup",
  "stats.langs": "translation languages",
  "stats.missing": "untranslated lines",

  "features.title": "What is translated",
  "features.lead":
    "The translation covers the game's text data: menus, dialogue, UI, item and quest descriptions. Art and audio are not touched.",
  "features.menu.title": "Menus and UI",
  "features.menu.text": "Main menu, options, buttons, hints and loading screens.",
  "features.dialog.title": "Dialogue and narration",
  "features.dialog.text": "Lines, thoughts, scene and item descriptions — every story string.",
  "features.rich.title": "Rich markup",
  "features.rich.text":
    "Italics, colour, size and TMP tags are preserved: {rich} marked-up lines are rebuilt, not dropped.",
  "features.fonts.title": "Fonts and CJK",
  "features.fonts.text":
    "Roboto Condensed for Latin and Cyrillic, Noto Sans SC/JP/KR for Chinese, Japanese and Korean. Glyph coverage is checked against the translation corpus.",
  "features.live.title": "Live switching",
  "features.live.text":
    "Open the language panel with F9; the choice is saved to active_lang.txt and applied without restarting the game.",
  "features.safe.title": "The game stays intact",
  "features.safe.text":
    "The mod's working files are only dwmapi.dll and the mods/NeonTranslatorDX/ folder. Steam's file verification does not re-download any game file.",

  "languages.title": "Languages",
  "languages.lead":
    "Ten translation languages plus the English original. The order follows Steam language statistics (config/language-priority.mts); coverage is computed from po/<lang>.po on every build.",
  "languages.cell": "{lines} lines · {pct}%",
  "languages.primary": "primary",
  "languages.source":
    "English is the source language: no dictionary is needed, the game runs as is.",

  "shots.title": "Screenshots",
  "shots.lead":
    "From the live game, not mock-ups: the main menu before and after, the language panel and the font check.",
  "shots.menuEn": "Main menu: the English original",
  "shots.menuRu": "Main menu: Russian translation",
  "shots.panel": "Language panel on F9: the English original and ten translations",
  "shots.specimen": "Chinese, Japanese and Korean: 0 tofu glyphs in the checked set",
  "shots.font": "Font selection: Cyrillic in the game menu",

  "install.title": "Installation",
  "install.lead":
    "Two paths: the (exe) installer and the manual archive. Both produce the same layout, install over an existing copy and leave nothing behind when removed.",
  "install.exe.title": "Installer (exe)",
  "install.exe.text":
    "Will find the Steam copy, check the version, copy the files and remove the mod without leftovers. Being prepared for release.",
  "install.exe.badge": "in progress",
  "install.manual.title": "Manual install (7z)",
  "install.manual.text":
    "Extract the archive into the game folder, run install.ps1, start the game. Useful when antivirus policy blocks executables.",
  "install.manual.link": "Download the archive",
  "install.steps.title": "Three steps",
  "install.step1": "Buy and install Third Crisis: Neon Nights on Steam.",
  "install.step2":
    "Extract the archive into the game folder (next to the game exe) and run install.ps1.",
  "install.step3": "Start the game and open the language panel with F9.",
  "install.layout.title": "What appears in the game folder",
  "install.layout.note":
    "Outside mods/NeonTranslatorDX/ there is only the dwmapi.dll loader. A manual install also places install.ps1 and README-INSTALL.md next to it; they can be deleted after installation.",
  "install.remove.title": "Removal without leftovers",
  "install.remove.text":
    "Delete dwmapi.dll and the mods/NeonTranslatorDX/ folder (for a manual install, also install.ps1 and README-INSTALL.md); the game returns to English. Saves and game files are not affected. After Steam → Verify integrity of game files, the game does not re-download a single file.",
  "install.steam.title": "If Steam removed dwmapi.dll",
  "install.steam.text":
    "That is expected: file verification removes files that are not part of the game. The mod folder usually stays; run install.ps1 or the installer again and the translation is back.",

  "faq.title": "Frequently asked questions",
  "faq.av.q": "My antivirus flags dwmapi.dll. Is it a virus?",
  "faq.av.a":
    "No. It is a small translation loader: it picks up NeonTranslatorDX.dll when the game starts and has no network access. Antivirus heuristics sometimes flag a substituted system DLL. Add the game folder to exclusions, restore the file from the archive and run install.ps1.",
  "faq.steam.q": "Steam removed dwmapi.dll after file verification. What now?",
  "faq.steam.a":
    "File verification removes everything that is not part of the original game; that is expected and proves the game files are not modified. The mods/NeonTranslatorDX/ folder usually stays. Run install.ps1 (or the installer) again and the file is back.",
  "faq.switch.q": "How do I switch the language in game?",
  "faq.switch.a":
    "Press F9 or open the language panel from the main menu. The choice is applied immediately and written to mods/NeonTranslatorDX/active_lang.txt. English is the native mode with no dictionary.",
  "faq.logs.q": "Where are the logs?",
  "faq.logs.a":
    "In mods/NeonTranslatorDX/NeonTranslatorDX.log. On a successful start it contains Lang: ru, source: ...patch_ru.dat and Translations: a number above zero. If the file is missing, the loader did not start.",
  "faq.exe.q": "What is the difference between the exe and the manual archive?",
  "faq.exe.a":
    "The file set is identical. The installer will find the game, check the version and remove the mod; the manual archive does the same through install.ps1 and suits portable setups.",

  "legal.title": "Legal notice",
  "legal.text":
    "An unofficial fan mod, not affiliated with Anduo Games. All rights to the game and its content belong to Anduo Games. A licensed copy is required. 18+ content: the translation keeps adult scenes and language without censorship or softening.",
  "links.title": "Links",
  "links.github": "GitHub — source and releases",
  "links.github.note": "Pipeline code, tasks and mod builds.",
  "links.nexus": "Nexus Mods",
  "links.nexus.note": "The mod page on Nexus is being prepared for publication.",
  "links.boosty": "Boosty — support the author",
  "links.boosty.note": "Project news and voluntary support.",
  "links.kofi": "Ko-fi — support the author",
  "links.kofi.note": "An alternative way to support the project.",

  "footer.built":
    "Page built on {date}. The numbers are recomputed from po/*.po at build time and are never edited by hand.",
};

export const SITE_TEXT: Record<SiteLang, Record<SiteMessageKey, string>> = {
  ru: RU,
  en: EN,
};

/** Названия языков на самих языках (для сетки; один и тот же список в обеих версиях). */
export const NATIVE_NAMES: Record<string, string> = {
  zh: "中文",
  ru: "Русский",
  es: "Español",
  pt: "Português",
  de: "Deutsch",
  ja: "日本語",
  fr: "Français",
  pl: "Polski",
  ko: "한국어",
  it: "Italiano",
};
