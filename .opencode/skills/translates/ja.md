# ja — 日本語翻訳ルール (EN→JA, adult visual novel)

Общее ядро — `core.md`. Только японская специфика; блок `PROMPT-START…END`
уходит в системный промпт (как `zh.md`).

<!-- PROMPT-START -->

Japanese specifics:

- Punctuation: full-width 。、！？；： and …… (six dots) for ellipsis. Quotes 「」 (nested 『』). No spaces between kana/kanji; no space before punctuation.
- Address: casual speech with lovers/friends (だ/だよ), polite です/ます with strangers and officials; keigo (尊敬語) only for real hierarchy. A sudden switch mid-scene is an error.
- No grammatical gender: pick 彼/彼女 by the SPEAKER field when a pronoun is really needed — Japanese usually omits pronouns, so prefer omission over guessing.
- Names in katakana: ゾーイ (Zoey), サラ (Sarah), クラウディア (Klaudia), リオ (Lio), ロージー (Rosie), レオナ (Leona), ノヴァ (Nova), マックス (Max, female), フェリシア (Felicia), ジェイミー (Jaime), サイファー (Cypher), トロフ (Trov), ヴァレン (Varen), カリアッハ (Calliach).
- Adult register: as explicit as the source — チンポ/肉棒 (cock), マンコ/アソコ (pussy), ケツ/尻 (ass), おっぱい/乳 (tits), イく/出す (cum), ヤる/犯す (fuck), クリトリス, 乳首. Never soften to 性器/下半身.
- Moans adapted to Japanese: あっ, んっ, はぁ, ふぅ, うぅ; keep っ and ー, never English letters.
- Tags <color=...>/<b>: byte-identical, parameters never translated.
- One source line = one output line; no line breaks.

<!-- PROMPT-END -->

## 1. 表記

- 句読点は全角（。、！？）、省略は「……」。
- 括弧は「」、入れ子は『』。英字のブランド（Smutgram、CUM）はそのまま。
- 漢字とかなの間にスペースを入れない。

## 2. 敬称・口調

- 恋人・友人には常体（だ・だよ）、他人・目上には敬体（です・ます）。
- 場面の途中で突然「です・ます」に戻るのは誤り（距離の変化として扱う）。

## 3. 成人向け語彙

| EN     | JA（普通） | JA（露骨） | 使わない     |
| ------ | ---------- | ---------- | ------------ |
| cock   | 肉棒       | チンポ     | 男性器       |
| pussy  | アソコ     | マンコ     | 膣（医学）   |
| ass    | お尻       | ケツ       | 肛門（医学） |
| tits   | 胸         | おっぱい   | 乳房（医学） |
| cum    | 出す       | イく       | 射精（医学） |
| fuck   | ヤる       | 犯す       | 性交         |
| clit   | クリトリス | —          | —            |
| nipple | 乳首       | —          | —            |

## 4. 名前（カタカナ）

ゾーイ、サラ、クラウディア、リオ、ロージー、レオナ、ノヴァ、マックス（女性）、フェリシア、
ジェイミー、サイファー、トロフ、ヴァレン、カリアッハ。
