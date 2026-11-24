# pt — regras de tradução (EN→PT, adult visual novel)

Общее ядро — `core.md`. Только португальская специфика; блок `PROMPT-START…END`
уходит в системный промпт.

<!-- PROMPT-START -->

Portuguese specifics (Brazilian Portuguese by default):

- Punctuation: `…` or `...` for ellipsis, `—` for dialogue dashes, quotes «…» (or “…” consistently). `¿`/`¡` do NOT exist in Portuguese.
- Address: `você` with lovers, friends and strangers (Brazilian norm); `tu` only where the scene is clearly regional/intimate; `o senhor / a senhora` for officials. A sudden switch mid-scene is an error.
- Gender: adjectives agree with the noun they describe. Participles with `você` follow the ADDRESSEE's gender; when unknown, rephrase to avoid the participle.
- Names stay as in the source (Zoey, Sarah, Klaudia, Lio, Rosie, Leona, Nova, Max, Felicia, Jaime, Cypher, Trov, Varen, Calliach). `Max` is a woman.
- Adult register: as explicit as the source — `pau` (cock), `buceta` (pussy), `bunda` (ass), `peitos` (tits), `gozar` (cum), `foder`/`transar` (fuck), `clitóris`, `mamilo`. Never soften to `membro`/`partes íntimas`.
- Interjections: `Ah!`, `Oh!`, `Uau`, `Ai!`, `Merda`, `Porra`; adapt moans to Portuguese phonetics, never keep English letters.
- Tags <color=...>/<b>: byte-identical, parameters never translated.
- One source line = one output line.

<!-- PROMPT-END -->

## 1. Лексика 18+

| EN          | PT (нейтр.)  | PT (грубо) | Не использовать    |
| ----------- | ------------ | ---------- | ------------------ |
| cock        | pau          | cacete     | membro             |
| pussy       | buceta       | xoxota     | vagina (clínico)   |
| ass         | bunda        | rabo       | ânus (clínico)     |
| tits        | peitos       | tetas      | mamas              |
| cum         | gozar, porra | leite      | ejacular (clínico) |
| fuck (verb) | transar      | foder      | manter relações    |
| clit        | clítoris     | —          | —                  |
| nipple      | mamilo       | —          | —                  |

## 2. Обращение и род

`você` — норма; `o senhor/a senhora` — официоз; `tu` — только явно региональная/интимная сцена.
Причастия с `você` согласуются с адресатом (`você está cansada`), а не со спикером.

## 3. Типографика

Одна строка = одна реплика; без переносов; бренды латиницей (`Smutgram`, `CUM`).
