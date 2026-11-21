# de — особенности перевода на немецкий (EN→DE, adult visual novel)

Статус DRAFT — написан по знаниям (не моделью: её черновик был браком),
нужен носитель. Правит только переводчик. Общее ядро — `core.md`.

<!-- PROMPT-START -->

German specifics:

- Address: du with lovers/friends, Sie with strangers/officials. Intimate switch to du is a closeness marker; sudden back to Sie mid-scene is an error.
- Gender/cases: grammatical der/die/das; adjectives and articles decline. Addressee gender from the speaker tag. Decline proper names (Dativ/Akkusativ).
- Moans/SFX adapted to German phonetics, never transliterated (full table below in section 3). Caps stay caps.
- Register: neutral-sensual vs explicit-harsh matched to scene (levels below in section 5). No clinical terms unless the character is deliberately clinical.
- Typography: quotes „...", ellipsis ..., Eszett ß per current rules.
- Length: German runs ~30% longer than English — keep UI lines short.

<!-- PROMPT-END -->

### 1. Род и падежи

TODO: грамматический род адресата, склонение прилагательных/артиклей,
склонение имён (Dativ/Akkusativ), обход рода при неизвестном.

### 2. Обращение: du / Sie

- Любовники, близкие, друзья → du
- Незнакомцы, официоз → Sie
- Переход Sie→du в интиме → маркер сближения; возврат к Sie в разгар — ошибка

### 3. Стоны и SFX (адаптировать под немецкую фонетику, не транслитерировать)

- `Ah! / Ahhh!` → `Ah! / Ahh!`
- `Oh! / Ohhh!` → `Oh! / Ohh!`
- `Mmm / Mmmm` → `Mhm / Mhmhm`
- `Ugh!` (натуга) → `Uff! / Ächz!`
- `Ew!` (отвращение) → `Igitt!`
- `Wow!` → `Wow! / Krass!`
- `Hey!` → `Hey!`
- `SLURP` → `SCHLÜRF`, `POP` → `PLOPP`, `THRUST` → `STOSS`, `DRIP` → `TROPF`, `KISS` → `SCHMATZ`
- Капслок сохранять, дефисы для слогов, звёздочки сохранять.

### 4. Fuck и god (уровни, не калька)

- Междометие: Scheiße/Mist (нейтрально-горячо), Verdammt (шок);
  глагол только в жёстком контексте: ficken/vögeln.
- God/oh god: TODO (что естественно в экстазе по-немецки).

### 5. Уровни лексики

- Уровень 1 (нейтрально-чувственный): Penis/Glied, Vulva/Scheide, Brüste, Samen/Sperma, kommen
- Уровень 2 (откровенно-грубый): Schwanz, Muschi, Titten, Wichse, ficken
- Клинические термины — только намеренно.

### 6. Словарь частей тела и действий

- `cock` → Penis / Glied; грубо: Schwanz
- `pussy` → Vulva / Scheide; грубо: Muschi
- `cum` → Samen / Sperma; грубо: Wichse
- `fuck (verb)` → ficken / vögeln (ур. 2); `suck` → saugen / blasen
- `moan` → Stöhnen / Seufzen / Ächzen
- Не повторять один термин 3+ строки подряд.

### 7. Естественность — никаких калек с английского

- Порядок слов немецкий: глагол в конце придаточных, не копировать SVO.
- False friends: `realize` ≠ realisieren (осуществлять); `actual` ≠ aktuell (текущий).
- Модальные частицы для живости: doch, mal, ja, denn.
- `I want you` → `Ich will dich` (прямо), не конструкции через «haben».
- `I want you` → `Ich will dich` (прямо), не конструкции через «haben».

### 8. Типографика

- Кавычки `„..."`, многоточие `...`, Eszett `ß` по новым правилам.

### 9. Консистентность (глоссарий, решает переводчик)

- `Zoey` → `Zoey` (feminine, indeclinable?)
- `Sarah` → `Sarah` (feminine)
- `Max` → `Max` (feminine! per RU corpus)
- `Nova` → `Nova` (feminine)
- `Klaudia` → `Klaudia` (feminine)
- `Jay` → `Jay` (masculine)
- `Redlight District` → `Rotlichtviertel`

Одинаковые английские фразы в разных файлах — одинаково. Контекст 3–5 строк.
