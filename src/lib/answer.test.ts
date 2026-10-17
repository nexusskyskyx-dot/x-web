import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeAnswer, type AnswerSource } from './answer.ts';

// No LLM key in tests — exercises the extractive path.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const sources: AnswerSource[] = [
  {
    title: 'Model Context Protocol',
    url: 'https://modelcontextprotocol.io',
    snippet:
      'The Model Context Protocol (MCP) is an open protocol that standardises how applications provide context to large language models. It was released by Anthropic in November 2024. MCP uses a client-server architecture.',
  },
  {
    title: 'Introducing MCP',
    url: 'https://www.anthropic.com/news/model-context-protocol',
    snippet:
      'Today we are open-sourcing the Model Context Protocol. MCP lets you build secure, two-way connections between your data and AI-powered tools. The protocol is transport agnostic.',
  },
  {
    title: 'Unrelated cookie notice',
    url: 'https://example.com/cookies',
    snippet: 'We use cookies to improve your experience. Subscribe to our newsletter for updates.',
  },
];

describe('answer synthesis', () => {
  test('builds a cited answer from the retrieved snippets', async () => {
    const answer = await synthesizeAnswer('what is the model context protocol', sources);

    assert.ok(answer, 'expected an answer');
    assert.equal(answer.mode, 'extractive');
    assert.ok(answer.text.length > 40);
    assert.ok(answer.citations.length >= 1);
    assert.ok(answer.citations[0].url.startsWith('https://'));
    assert.ok(answer.confidence > 0.3);
  });

  test('every bracketed citation points at a real source', async () => {
    const answer = await synthesizeAnswer('what is the model context protocol', sources);
    assert.ok(answer);

    const markers = [...answer.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    assert.ok(markers.length > 0, 'expected inline citation markers');
    const indices = new Set(answer.citations.map((c) => c.index));
    for (const marker of markers) {
      assert.ok(indices.has(marker), `answer cites [${marker}] but no such citation exists`);
    }
  });

  test('citation indices are sequential and match result positions', async () => {
    const answer = await synthesizeAnswer('what is the model context protocol', sources);
    assert.ok(answer);

    answer.citations.forEach((citation, i) => {
      assert.equal(citation.index, i + 1, 'citation indices must be 1-based and sequential');
      assert.equal(citation.url, sources[citation.result].url);
    });
  });

  test('excludes boilerplate sentences from the answer', async () => {
    const answer = await synthesizeAnswer('what is the model context protocol', sources);
    assert.ok(answer);
    assert.ok(!/cookie|newsletter|subscribe/i.test(answer.text));
  });

  test('declines rather than inventing an answer from off-topic sources', async () => {
    const offTopic: AnswerSource[] = [
      {
        title: 'Sourdough starters',
        url: 'https://example.com/bread',
        snippet: 'A sourdough starter is a fermented culture of flour and water used to leaven bread.',
      },
    ];
    const answer = await synthesizeAnswer('what is the model context protocol', offTopic);

    // Either no answer at all, or an explicit decline with no text.
    if (answer) {
      assert.equal(answer.declined, true);
      assert.equal(answer.text, '');
    }
  });

  test('returns undefined when there are no usable sources', async () => {
    assert.equal(await synthesizeAnswer('anything', []), undefined);
    assert.equal(
      await synthesizeAnswer('anything', [{ title: 'Empty', url: 'https://x.com', snippet: '' }]),
      undefined,
    );
  });

  test('prefers the provider answer over extractive synthesis', async () => {
    const answer = await synthesizeAnswer('what is the model context protocol', sources, {
      providerAnswer: 'MCP is an open protocol for connecting AI apps to data sources.',
    });

    assert.ok(answer);
    assert.equal(answer.mode, 'provider');
    assert.match(answer.text, /open protocol/);
    assert.ok(answer.citations.length >= 1, 'provider answers still carry sources');
  });

  test('uses a saved BYOK model and reports that provider in answer metadata', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody: any;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'MCP is an open protocol for connected context. [1]' } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const answer = await synthesizeAnswer('what is the model context protocol', sources, {
        allowLlm: true,
        aiConfig: { provider: 'groq', model: 'llama-test', apiKey: 'user-secret', source: 'byok' },
      });
      assert.ok(answer);
      assert.equal(answer.mode, 'llm');
      assert.equal(answer.ai_provider, 'groq');
      assert.equal(answer.ai_key_source, 'byok');
      assert.equal(requestUrl, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(requestBody.model, 'llama-test');
      assert.equal(requestBody.messages[0].content.startsWith('You are the answer engine'), true);
    } finally { globalThis.fetch = originalFetch; }
  });

  test('does not carry the LLM path when no model is configured', async () => {
    // No keys set — must fall through to extractive, not throw.
    const answer = await synthesizeAnswer('what is the model context protocol', sources, {
      allowLlm: true,
    });
    assert.ok(answer);
    assert.notEqual(answer.mode, 'llm');
  });
});
