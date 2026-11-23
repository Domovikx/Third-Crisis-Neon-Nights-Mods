//! pot_skip: порт `.opencode/skills/extract-text/tests/pot_skip.test.mts`.
//!
//! Главный тест — ловушка 2026-11-23: наивная чистка `<[^>]+>` съедает
//! авторские кавычки `< … >` вместе с реальным тегом, и дефект маскируется.

use rust_l10n::pot_skip::{
    classify_rich, has_letters, skip_condition_matches, strip_tmp_tags, RichRelation, SkipCondition,
};

const REAL_FRAGMENT: &str = "<i>< Like this, hmmm...? I love these nice big tits. Especially when adorable customers like <b>you</b> request them. >";

/// Наивная чистка `<[^>]+>`: от `<` до ближайшего `>` — именно она маскирует
/// дефект (на этом владелец уже наступил тремя скриптами).
fn naive_strip(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('>') {
            Some(close) => rest = &after[close + 1..],
            None => {
                rest = &rest[open..];
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

#[test]
fn кавычки_остаются_текстом_а_известные_теги_снимаются() {
    let plain = strip_tmp_tags(REAL_FRAGMENT);
    // `<b>` — настоящий тег, снят; `< Like this…` — авторская кавычка, осталась.
    assert!(!plain.contains("<b>"), "{plain}");
    assert!(plain.starts_with("< Like this"), "{plain}");
    assert!(plain.contains("like you request them. >"), "{plain}");

    // Ловушка: наивная чистка даёт ровно msgid, то есть «всё хорошо».
    assert_eq!(naive_strip(REAL_FRAGMENT), "you request them. >");
    assert_ne!(plain, "you request them. >");
}

#[test]
fn настоящий_обрывок_классифицируется_как_хвост() {
    let check = classify_rich("you request them. >", REAL_FRAGMENT);
    assert_eq!(check.relation, RichRelation::Suffix);
    assert!(check.plain.ends_with("you request them. >"), "{check:?}");
}

#[test]
fn порог_отсекает_шум_из_шрифтовой_разметки() {
    // В дампе шесть таких: text = ">", rich — «<< … >>».
    let check = classify_rich(">", "<< Declination processed. Proceeding relocation. >>");
    assert_eq!(check.relation, RichRelation::Noise);
}

#[test]
fn расхождение_на_символ_это_mismatch_не_хвост() {
    let rich = "Your new Neon-Trust Reserve account is now open! Your new pin number is as follows... <<color=yellow>7192</color>>";
    let check = classify_rich(
        "Your new Neon-Trust Reserve account is now open! Your new pin number is as follows... 7192>",
        rich,
    );
    assert_eq!(check.relation, RichRelation::Mismatch);
}

#[test]
fn норма_с_тегами_и_цветами() {
    for (id, rich) in [
        ("Hi", "<i>Hi</i>"),
        ("Hi", "<color=#EB83FF><i>Hi</i></color>"),
        ("Hi", "<B>Hi</B>"),
        ("", ""),
    ] {
        assert_eq!(classify_rich(id, rich).relation, RichRelation::Ok, "{rich}");
    }
    // Пробельные различия — норма: msgid обрезан, rich с ведущим пробелом.
    assert_eq!(
        classify_rich("> Cum for me.", "<i> > Cum for me.").relation,
        RichRelation::Ok
    );
}

#[test]
fn условия_правил() {
    assert!(has_letters("!AL7"), "буквы A и L есть — это не noLetters");
    assert!(has_letters("wK Ax"));
    assert!(!has_letters("«123»"));
    assert!(
        skip_condition_matches(SkipCondition::ShortToken, "?|b", ""),
        "без пробела, 3 символа"
    );
    // Примеры владельца оба С ПРОБЕЛОМ — shortToken их НЕ ловит (см. отчёт).
    assert!(!skip_condition_matches(
        SkipCondition::ShortToken,
        "w? |b",
        ""
    ));
    assert!(
        !skip_condition_matches(SkipCondition::ShortToken, "wK Ax", ""),
        "пробел"
    );
    assert!(!skip_condition_matches(
        SkipCondition::ShortToken,
        "abcdefghijklm",
        ""
    ));
    assert!(skip_condition_matches(
        SkipCondition::NoLetters,
        "«123»",
        ""
    ));
    assert!(skip_condition_matches(
        SkipCondition::Fragment,
        "you request them. >",
        REAL_FRAGMENT
    ));
    assert!(!skip_condition_matches(
        SkipCondition::Fragment,
        ">",
        "<< Declination processed. Proceeding relocation. >>"
    ));
}
