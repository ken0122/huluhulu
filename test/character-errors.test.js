import test from 'node:test';
import assert from 'node:assert/strict';
import {CharacterError,characterErrorMessage,characterErrorDetails,CHARACTER_ERROR_MESSAGES} from '../src/character-errors.js';

test('all seven locales preserve distinct generation failures and bounded field details',()=>{
  for(const [locale,messages] of Object.entries(CHARACTER_ERROR_MESSAGES)) {
    assert.equal(Object.keys(messages).length,21);
    const codes=['CHAR_EMPTY_REPLY','CHAR_TIMEOUT','CHAR_AUTH','CHAR_JSON','CHAR_TRUNCATED','CHAR_RATE','CHAR_TRANSLATION_TIMEOUT','CHAR_REPAIR_TIMEOUT','CHAR_PROVIDER_SETTINGS'];
    assert.equal(new Set(codes.map(code=>characterErrorMessage(locale,{code}))).size,codes.length);
    const error=new CharacterError('CHAR_TEXT_LONG','secret provider body',{field:'en.headpat[1]',maximum:50,length:65,provider:'secret'});
    const details=characterErrorDetails(error);
    assert.deepEqual(details,{field:'en.headpat[1]',maximum:50,length:65});
    const message=characterErrorMessage(locale,{code:error.code,details});
    assert.match(message,/en.headpat\[1\]/);assert.match(message,/50/);assert.match(message,/65/);assert.ok(!message.includes('secret'));
  }
});

test('HTTP status and invalid field survive localization without leaking provider data', () => {
  for (const locale of Object.keys(CHARACTER_ERROR_MESSAGES)) {
    const http = new CharacterError('CHAR_HTTP', 'secret', { status: 404, provider: 'secret' });
    assert.deepEqual(characterErrorDetails(http), { status: 404 });
    assert.match(characterErrorMessage(locale, http), /HTTP 404/);
    assert.ok(!characterErrorMessage(locale, http).includes('secret'));
    assert.match(characterErrorMessage(locale, new CharacterError('CHAR_INVALID_OUTPUT', 'secret', {field:'dialogueTranslations.ru.headpat'})), /dialogueTranslations.ru.headpat/);
  }
  assert.deepEqual(characterErrorDetails(new CharacterError('CHAR_HTTP', '', { status: 'secret', field: 'private/response' })), {});
});

test('timeouts report the actual bounded deadline in all languages', () => {
  for(const locale of Object.keys(CHARACTER_ERROR_MESSAGES)) {
    for(const code of ['CHAR_TIMEOUT','CHAR_TRANSLATION_TIMEOUT','CHAR_REPAIR_TIMEOUT']) {
      for(const seconds of [30,90]) {
        const error=new CharacterError(code,'private',{timeoutSeconds:seconds});
        assert.deepEqual(characterErrorDetails(error),{timeoutSeconds:seconds});
        assert.ok(characterErrorMessage(locale,error).includes(String(seconds)));
      }
      assert.ok(characterErrorMessage(locale,{code,details:{timeoutSeconds:999}}).includes('30'));
    }
  }
});
