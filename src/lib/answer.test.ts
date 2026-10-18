import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeAnswer, type AnswerSource } from './answer.ts';

// No LLM key in tests — exercises the extractive path.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.XWEB_ANSWER_MODEL;

const sources: AnswerSource[] = [
  {
    title: 'Model Context Protocol',
    url: 'https://modelcontextprotocol.io',
    snippet:
      'The Model Context Protocol (MCP) is an open protocol that standardises how applications provide context to large language models. It was released by Anthropic in November 2024. MCP uses a client-server architecture.',
    raw_content:
      'The Model Context Protocol (MCP) is an open protocol that standardises how applications provide context to large language models. It was released by Anthropic in November 2024. MCP uses a client-server architecture.',
  },
  {
    title: 'Introducing MCP',
    url: 'https://www.anthropic.com/news/model-context-protocol',
    snippet:
      'Today we are open-sourcing the Model Context Protocol. MCP lets you build secure, two-way connections between your data and AI-powered tools. The protocol is transport agnostic.',
    raw_content:
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

  test('flags claims that do not match the cited scraped source text', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'The Model Context Protocol is an open protocol [1]. Satellite dishes have no effect on MCP [1].' } }],
    }), { status: 200 })) as typeof fetch;
    try {
      const answer = await synthesizeAnswer('what is the model context protocol', sources, {
        allowLlm: true,
        aiConfig: { provider: 'groq', model: 'llama-test', apiKey: 'user-secret', source: 'byok' },
      });
      assert.ok(answer);
      assert.equal(answer.mode, 'llm');
      assert.match(answer.text, /Satellite dishes have no effect on MCP \[Unverified\]/);
      assert.deepEqual(answer.citation_verification, {
        status: 'flagged',
        supported_claims: 1,
        flagged_claims: 1,
        method: 'source_text_overlap',
      });
      assert.deepEqual(answer.citations.map((citation) => citation.index), [1]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test('runs one optional semantic review through the saved BYOK model and validates its exact quote', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const requestModels: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      const body = JSON.parse(String(init?.body ?? '{}'));
      requestModels.push(body.model);
      const content = requests === 1
        ? 'MCP creates a standardized channel for software to transmit relevant context to AI systems [1]'
        : JSON.stringify({ results: [{ id: 1, verdict: 'supported', quote: 'The Model Context Protocol (MCP) is an open protocol that standardises how applications provide context to large language models.' }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const answer = await synthesizeAnswer('what is the model context protocol', [sources[0]], {
        allowLlm: true,
        semanticCitationCheck: true,
        aiConfig: { provider: 'groq', model: 'llama-test', apiKey: 'user-secret', source: 'byok' },
      });
      assert.ok(answer);
      assert.equal(requests, 2, 'one answer call and one batched semantic review call');
      assert.deepEqual(requestModels, ['llama-test', 'llama-test']);
      assert.match(answer.text, /\[1\]/);
      assert.deepEqual(answer.citation_verification, {
        status: 'supported',
        supported_claims: 1,
        flagged_claims: 0,
        method: 'lexical_plus_semantic',
        semantic_checked_claims: 1,
        semantic_supported_claims: 1,
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  test('does not accept a semantic verdict without an exact quote found in the cited page', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      const content = requests === 1
        ? 'The Model Context Protocol is an open protocol [1]. MCP creates a standardized channel for software to transmit relevant context to AI systems [1]'
        : JSON.stringify({ results: [{ id: 1, verdict: 'supported', quote: 'This claim is fully supported by magic.' }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const answer = await synthesizeAnswer('what is the model context protocol', [sources[0]], {
        allowLlm: true,
        semanticCitationCheck: true,
        aiConfig: { provider: 'groq', model: 'llama-test', apiKey: 'user-secret', source: 'byok' },
      });
      assert.ok(answer);
      assert.equal(requests, 2);
      assert.match(answer.text, /MCP creates a standardized channel.*\[Unverified\]/);
      assert.deepEqual(answer.citations.map((citation) => citation.index), [1]);
      assert.deepEqual(answer.citation_verification, {
        status: 'flagged', supported_claims: 1, flagged_claims: 1,
        method: 'lexical_plus_semantic', semantic_checked_claims: 1,
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  test('routes OpenRouter BYOK through its OpenAI-compatible endpoint', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestHeaders: HeadersInit | undefined;
    let requestBody: any;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'MCP is an open protocol for connected context. [1]' } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const answer = await synthesizeAnswer('what is the model context protocol', sources, {
        allowLlm: true,
        aiConfig: { provider: 'openrouter', model: 'openai/gpt-5.2', apiKey: 'openrouter-user-key', source: 'byok' },
      });
      assert.ok(answer);
      assert.equal(answer.mode, 'llm');
      assert.equal(answer.ai_provider, 'openrouter');
      assert.equal(answer.ai_key_source, 'byok');
      assert.equal(requestUrl, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(requestBody.model, 'openai/gpt-5.2');
      assert.equal(new Headers(requestHeaders).get('authorization'), 'Bearer openrouter-user-key');
      assert.equal(new Headers(requestHeaders).get('x-openrouter-title'), 'x-web');
    } finally { globalThis.fetch = originalFetch; }
  });

  test('routes xKiro BYOK through its OpenAI-compatible endpoint', async () => {
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
        aiConfig: { provider: 'xkiro', model: 'openai/gpt-5.6-sol', apiKey: 'xkiro-user-key', source: 'byok' },
      });
      assert.ok(answer);
      assert.equal(answer.mode, 'llm');
      assert.equal(answer.ai_provider, 'xkiro');
      assert.equal(answer.ai_key_source, 'byok');
      assert.equal(requestUrl, 'https://api.xkiro.com/v1/chat/completions');
      assert.equal(requestBody.model, 'openai/gpt-5.6-sol');
    } finally { globalThis.fetch = originalFetch; }
  });

  test('does not use server-managed model credentials; AI synthesis requires BYOK', async () => {
    const oldEnv = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      groq: process.env.GROQ_API_KEY,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
    };
    process.env.OPENAI_API_KEY = 'server-openai-secret';
    process.env.ANTHROPIC_API_KEY = 'server-anthropic-secret';
    process.env.GROQ_API_KEY = 'server-groq-secret';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cloudflare-account';
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare-secret';
    try {
      const answer = await synthesizeAnswer('what is the model context protocol', sources, {
        allowLlm: true,
      });
      assert.ok(answer);
      assert.notEqual(answer.mode, 'llm');
    } finally {
      for (const [key, value] of Object.entries({
        OPENAI_API_KEY: oldEnv.openai,
        ANTHROPIC_API_KEY: oldEnv.anthropic,
        GROQ_API_KEY: oldEnv.groq,
        CLOUDFLARE_ACCOUNT_ID: oldEnv.cloudflareAccountId,
        CLOUDFLARE_API_TOKEN: oldEnv.cloudflareToken,
      })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
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
