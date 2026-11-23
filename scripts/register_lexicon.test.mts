/**
 * register_lexicon.test.mts — механический регистр 18+.
 *
 * Проверка идёт без модели: клинические термины, границы слов (ложные
 * срабатывания «анус» в «останусь») и потеря откровенности.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { clinicalHits, softenedHits } from "./register_lexicon.mts";

test("clinicalHits: канцелярщина ловится, нормальный регистр — нет", () => {
  assert.deepEqual(clinicalHits("Он вошёл в её половой член"), ["половой акт"]);
  assert.deepEqual(clinicalHits("половой акт был долгим"), ["половой акт"]);
  assert.deepEqual(clinicalHits("Он вошёл в неё"), [], "художественный регистр чист");
  assert.deepEqual(clinicalHits("Она посмотрела на его член"), []);
});

test("clinicalHits: слабые слова сами по себе не дефект", () => {
  assert.deepEqual(clinicalHits("Её клитор пульсировал"), [], "клитор — weak");
  assert.deepEqual(clinicalHits("влагалище сжалось"), [], "влагалище — weak");
  assert.deepEqual(clinicalHits("гениталии наружу"), ["гениталии"]);
});

test("clinicalHits: границы слова не дают ложных срабатываний", () => {
  assert.deepEqual(clinicalHits("Я останусь здесь"), [], "«анус» внутри «останусь»");
  assert.deepEqual(clinicalHits("прямая кишка сжалась"), ["прямая кишка"]);
});

test("softenedHits: откровенное слово потеряно — кандидат на вычитку", () => {
  assert.deepEqual(softenedHits("Suck my cock.", "Соси."), ["cock/dick"]);
  assert.deepEqual(softenedHits("Suck my cock.", "Соси мой член."), []);
  assert.deepEqual(softenedHits("He slapped her ass.", "Он шлёпнул её."), ["ass"]);
  assert.deepEqual(softenedHits("Look at the sunset.", "Посмотри на закат."), []);
});

test("softenedHits: падежи и синонимы считаются сохранением", () => {
  assert.deepEqual(softenedHits("His cock twitched.", "Его хер дёрнулся."), []);
  assert.deepEqual(softenedHits("She spread her pussy.", "Она раздвинула киску."), []);
  assert.deepEqual(softenedHits("Fuck me!", "Трахни меня!"), []);
});

test("softenedHits: междометия и идиомы — не смягчение", () => {
  // «Fuck!» как выкрик переводится «Чёрт/Бля» — это норма, а не потеря.
  assert.deepEqual(
    softenedHits("Fuck! That sound slipped out...", "Чёрт! Этот звук вырвался..."),
    [],
  );
  assert.deepEqual(softenedHits("Fuck you're so wet", "Ох, бля, ты такая мокрая"), []);
  // «snatch a pic» — про фото, а не про тело.
  assert.deepEqual(softenedHits("let me snatch a pic of you", "дай сделать фото"), []);
});

test("softenedHits: падежи и приставки считаются сохранением", () => {
  assert.deepEqual(softenedHits("a pair of boobs", "пара сисек"), []);
  assert.deepEqual(softenedHits("in her ass", "в попе"), []);
  assert.deepEqual(softenedHits("massive ass", "огромного зада"), []);
  assert.deepEqual(softenedHits("Pocket Pussy Vendor", "Продавец карманных кисок"), []);
  assert.deepEqual(softenedHits("I'd love to fuck your ass", "Я бы оттрахал твою задницу"), []);
});

test("softenedHits: реальная потеря откровенности ловится", () => {
  assert.deepEqual(
    softenedHits("I'd love to fuck your ass in my room", "затолкал тебя в комнату"),
    ["ass", "fuck (sexual)"],
  );
  assert.deepEqual(softenedHits("make me cum", "доведёшь меня до конька"), ["cum/semen"]);
});
