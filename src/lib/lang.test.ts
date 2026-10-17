import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, resolveLanguage } from './lang.ts';

describe('language detection', () => {
  test('detects common Latin-script languages from function words', () => {
    const cases: Array<[string, string]> = [
      ['What is the latest news about web search?', 'en'],
      ['¿Qué es el protocolo de contexto de modelo?', 'es'],
      ['Comment déployer une application sur Vercel', 'fr'],
      ['Was ist das Model Context Protocol?', 'de'],
      ['Como funciona o protocolo de contexto do modelo?', 'pt'],
      ['Come funziona il protocollo di contesto del modello?', 'it'],
    ];
    for (const [query, expected] of cases) {
      assert.equal(detectLanguage(query).language, expected, query);
    }
  });

  test('detects writing systems directly', () => {
    const cases: Array<[string, string]> = [
      ['モデルコンテキストプロトコルとは何ですか', 'ja'],
      ['모델 컨텍스트 프로토콜이란 무엇인가요', 'ko'],
      ['Что такое Model Context Protocol?', 'ru'],
      ['ما هو بروتوكول سياق النموذج', 'ar'],
      ['מהו פרוטוקול הקשר של מודל', 'he'],
      ['模型上下文协议是什么', 'zh'],
      ['โมเดลคอนเท็กซ์โพรโทคอลคืออะไร', 'th'],
    ];
    for (const [query, expected] of cases) {
      assert.equal(detectLanguage(query).language, expected, query);
    }
  });

  test('returns unknown for empty and content-word-only queries', () => {
    assert.equal(detectLanguage('').language, 'und');
    assert.equal(detectLanguage('MCP Vercel Astro').language, 'und');
  });

  test('resolveLanguage auto-detects and defaults to English when uncertain', () => {
    assert.equal(resolveLanguage('auto', '¿Qué es MCP?').language, 'es');
    assert.equal(resolveLanguage(undefined, 'MCP Vercel Astro').language, 'en');
  });

  test('explicit BCP-47 language wins and normalizes to primary tag', () => {
    const result = resolveLanguage('pt-BR', 'What is MCP?');
    assert.equal(result.language, 'pt');
    assert.equal(result.auto, false);
  });
});
