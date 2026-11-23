# zh — 中文翻译规则 (EN→ZH, adult visual novel)

Общее ядро — `core.md`. Здесь только китайская специфика. Блок разметки промпта
(начало-конец ниже) уходит в системный промпт (см. `loadLangSkill` в `translate-local`),
остальное — для ревью и людей.

<!-- PROMPT-START -->
Chinese specifics:
- Punctuation is full-width: 。 ， ！ ？ ； ： 、 and …… (six dots) for ellipsis. No spaces before punctuation, no spaces between Chinese characters. Do not leave ASCII . , ! ? inside Chinese sentences.
- Quotation: “ ” for speech (or keep the source's quotes if any), 「」 only inside nested quotes.
- Keep Latin brand names and acronyms unchanged: CUM, CLIT, Smutgram, Pocket Pussy, Neon-Trust.
- Names (canonical): 佐伊=Zoey, 莎拉=Sarah, 克劳迪娅=Klaudia, 利奥=Lio, 罗茜=Rosie, 莉昂娜=Leona, 诺瓦=Nova, 马克斯=Max (female!), 费莉西娅=Felicia, 杰米=Jaime, 赛弗=Cypher, 特罗夫=Trov, 瓦伦=Varen, 卡利亚赫=Calliach. Never invent a second transliteration for the same character.
- Chinese has no grammatical gender and no verb agreement: pick 他 (male) / 她 (female) by the SPEAKER field; narration in Zoey's inner voice is 她.
- Address: 你 with lovers, friends and strangers in this adult setting; 您 only for officials and formal service.
- Adult register: be as explicit as the source. Use 鸡巴/肉棒 (cock), 小穴/逼 (pussy), 屁股 (ass), 奶子/胸 (tits), 射精/射 (cum), 操/干 (fuck), 阴蒂 (clit), 乳头 (nipple). Never soften to 生殖器/器官/下体 unless the source itself is clinical.
- Moans and breathing: adapt to Chinese interjections (啊 嗯 哈 呃 唔) with …… and ！; never keep English moan letters (Fhh, Ngh).
- Rich tags <color=...>, <b>, <size=...>: keep byte-identical, translate only the text inside; never translate tag parameters.
- One source line = one output line. Never insert line breaks or full-width spaces.
- Code, ids, paths, versions and pure symbols: output unchanged.
<!-- PROMPT-END -->

## 1. 标点与空格

- 句号 。 逗号 ， 顿号 、 分号 ； 冒号 ： 问号 ？ 感叹号 ！ 全部全角。
- 省略号 ……（六个点，两个省略号字符），不用 `...`。
- 引号 “ ”，嵌套用 「 」；不要用英文直引号 " "。
- 英文字母/数字与汉字之间不加空格（游戏 UI 紧凑优先），拉丁词组内部空格保留：
  `Pocket Pussy` 原样，`1000` 原样。
- 数字范围用 `–`（短横）或 `-`，与原文一致；不改成全角。
- 破折号 ——（两个全角横线），左右不加空格。

## 2. 语气与体

- 你 = 亲近/平辈/陌生人（本作默认）；您 = 官方、上级、服务场合的正式称呼。
- 亲密场景中突然出现「您」= 错误（和俄语里的 Вы 一样）。
- 没有性/数/格变化：不要为了「文雅」加「们」「的」等冗余字。
- 口语感叹词按中文习惯：Хм→嗯，Ах→啊，Ох→哦/喔，Угх→呃。

## 3. 呻吟与拟声

英文拟声不要逐字母转写，用中文拟声：

| 英文            | 中文              |
| --------------- | ----------------- |
| `Ah! / Ahhh!`   | 啊！/ 啊啊！      |
| `Oh! / Ohhh!`   | 哦！/ 喔——！      |
| `Mmm / Mmmm`    | 嗯… / 嗯嗯…       |
| `Hmm`           | 嗯                |
| `Nghh / Mngh`   | 唔… / 嗯…         |
| `Hhh / Hhhh`    | 呼… / 哈…         |
| `Fuck!`         | 操！/ 妈的！      |
| `Fhaaa!`        | 哈啊！            |
| `Ugh / Urgh`    | 呃 / 啧           |
| `Khh`           | 咳… / 呃…         |

- 保持 `……` 表示断续，`！` 表示喊叫；不要保留英文的 `~`（改用「～」或去掉）。
- 大写强调（`SLURP`）→ 中文加感叹或拟声重复（`咕咚咕咚`），不要用拉丁大写。

## 4. 成人词汇（18+）

| 英文          | 一级（常用） | 二级（粗俗） | 不要用     |
| ------------- | ------------ | ------------ | ---------- |
| cock / dick   | 肉棒、阴茎   | 鸡巴         | 生殖器     |
| pussy / cunt  | 小穴、蜜穴   | 逼           | 阴道（临床）|
| ass / asshole | 屁股、臀     | 屁眼         | 肛门（临床）|
| tits / boobs  | 胸、乳房     | 奶子         | 乳腺       |
| cum / semen   | 精液         | 精           | 分泌物     |
| fuck (verb)   | 做爱、进入   | 操、干       | 性交       |
| clit          | 阴蒂         | 豆豆         | —          |
| nipple        | 乳头         | 奶头         | —          |

Правило: регистр перевода = регистр оригинала. Если в оригинале `cock`, то «肉棒/鸡巴»,
а не «生殖器».

## 5. 名字（音译）

| 英文       | 中文         | 备注          |
| ---------- | ------------ | ------------- |
| Zoey       | 佐伊         | 女主          |
| Sarah      | 莎拉         |               |
| Klaudia    | 克劳迪娅     |               |
| Lio        | 利奥         | 男            |
| Rosie      | 罗茜         |               |
| Leona      | 莉昂娜       |               |
| Nova       | 诺瓦         |               |
| Max        | 马克斯       | **女性！**    |
| Felicia    | 费莉西娅     |               |
| Jaime      | 杰米         |               |
| Cypher     | 赛弗         |               |
| Trov       | 特罗夫       |               |
| Varen      | 瓦伦         |               |
| Calliach   | 卡利亚赫     |               |
| Enforcer   | 执法者       | 不是「执行者」|

Имена пишутся по таблице; новая форма = ошибка (как «Роузи» в русском).

## 6. 术语（游戏世界）

| 英文                | 中文       |
| ------------------- | ---------- |
| Crush (drug/state)  | 冲动       |
| Crush Blocker       | 冲动阻断器 |
| Andro                | 安卓人     |
| Slutbox             | 荡妇盒     |
| Smutgram            | Smutgram（品牌，不译） |
| EZMail              | EZMail（品牌） |
| Glowing Hole        | 霓虹洞     |
| Neon Rise           | 霓虹崛起   |
| Cartel              | 卡特尔     |

## 7. 排版与断行

- 一行一句，不手动换行；对话框会自动折行。
- 不在汉字之间加空格，不在标点前加空格。
- 省略号 `……` 算两个字符；不要用 `...` 或 `。。。`。

## 8. 数字与量词

- 数字用半角阿拉伯数字：`3`、`10%`。
- 量词按名词选：次（次数）、个（物品）、件（衣服）、分（分数/分钟）。
- 分数/百分比：`10%` 原样。

## 9. 一致性（术语与名字）

Таблица выше (раздел 5 и 6) — канон. Одинаковые английские фразы переводить одинаково;
контекст 3–5 строк обязателен.

## 10. 校验（QA）

- 标记 `<color>`、`<b>` 未丢、未翻译参数；
- 没有半角标点混进中文句子；
- 名字只有一种写法；
- 行数 = 原行数（每行一个输出）。
