import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAcceptLanguageHeader,
  buildLocaleLanguages,
  buildSyntheticSpeechVoices,
} from './browser-context';

test('buildLocaleLanguages keeps locale-first ordering and adds English fallback', () => {
  assert.deepEqual(buildLocaleLanguages('de-DE'), ['de-DE', 'de', 'en-US', 'en']);
});

test('buildAcceptLanguageHeader aligns with locale-first ordering', () => {
  assert.equal(buildAcceptLanguageHeader('de-DE'), 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
});

test('buildSyntheticSpeechVoices starts with a locale-aligned voice', () => {
  const voices = buildSyntheticSpeechVoices('de-DE');

  assert.equal(voices[0]?.lang, 'de-DE');
  assert.match(voices[0]?.name ?? '', /German/i);
  assert.equal(voices[0]?.default, true);
});
