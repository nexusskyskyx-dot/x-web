import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, PipelineError } from './pipeline.ts';

// Keep the pipeline off the network: no upstream x-web, no LLM, no extraction.
before(() => {
  delete process.env.XWEB_API_BASE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

const TAVILY_PAYLOAD = {
  query: 'model context protocol',
  answer: 'MCP is an open protocol that standardises how apps give context to LLMs.',
  results: [
    {
      title: 'Model Context Protocol',
      url: 'https://modelcontextprotocol.io',
      content:
        'The Model Context Protocol is an open protocol that standardises how applications provide context to large language models. It defines a client-server architecture and supports stdio and HTTP transports.',
      score: 0.97,
      published_date: '2024-11-25',
    },
    {
      title: 'Introducing MCP',
      url: 'https://www.anthropic.com/news/model-context-protocol',
      content:
        'Today we are open-sourcing the Model Context Protocol, a way to connect AI systems to the tools and data where they live.',
      score: 0.91,
    },
  ],
};

function mockProvider(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

describe('search pipeline', () => {
  test('returns the full v1 contract', async () => {
    const calls = mockProvider(TAVILY_PAYLOAD);
    const result = await runPipeline(
      { query: 'what is the model context protocol' },
      { apiKey: 'tvly-test' },
    );

    assert.equal(calls.length, 1, 'should call the provider exactly once');
    assert.equal(result.object, 'search');
    assert.match(result.id, /^xweb_/);
    assert.equal(result.query, 'what is the model context protocol');
    assert.equal(result.provider, 'tavily');
    assert.equal(typeof result.took_ms, 'number');
    assert.ok(Array.isArray(result.results) && result.results.length === 2);

    // results carry normalised ISO dates
    assert.ok(result.results.some((hit) => hit.published_date === '2024-11-25T00:00:00.000Z'));

    // language resolution
    assert.equal(result.language.resolved, 'en');
    assert.equal(result.language.detected.language, 'en');
    assert.equal(result.language.requested, 'auto');
    assert.ok(!result.unsupported_params?.includes('language'));

    // query understanding
    assert.ok(result.intent, 'expected an intent block');
    assert.equal(result.intent.type, 'definition');

    // synthesised answer with citations
    assert.ok(result.answer, 'expected an answer');
    assert.ok(result.answer.text.length > 0);
    assert.ok(result.answer.citations.length > 0);

    // "what is the …" is scaffolding — it gets stripped before the index call
    assert.equal(result.meta.rewritten, true);
    assert.equal(result.meta.effective_query, 'model context protocol');
    assert.equal(JSON.parse(calls[0].init.body as string).query, 'model context protocol');
    assert.equal(typeof result.meta.stages_ms.search, 'number');
  });

  test('sends an understood recency window to the provider', async () => {
    const calls = mockProvider(TAVILY_PAYLOAD);
    await runPipeline({ query: 'latest news on MCP' }, { apiKey: 'tvly-test' });

    const body = JSON.parse(calls[0].init.body as string);
    // Tavily only applies `days` on the news topic
    assert.equal(body.topic, 'news');
    assert.equal(body.days, 7);
    assert.equal(body.query, 'latest news on MCP');
  });

  test('rewrites verbose queries before hitting the index', async () => {
    const calls = mockProvider(TAVILY_PAYLOAD);
    const result = await runPipeline(
      { query: 'hey, can you please tell me what the model context protocol is exactly' },
      { apiKey: 'tvly-test' },
    );

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(result.meta.rewritten, true);
    assert.notEqual(body.query, result.query);
    assert.ok(!/please|tell me/i.test(body.query), `query was still verbose: ${body.query}`);
  });

  test('query_rewrite=off keeps the original wording', async () => {
    const calls = mockProvider(TAVILY_PAYLOAD);
    const result = await runPipeline(
      { query: 'hey, can you please tell me what the model context protocol is exactly', query_rewrite: 'off' },
      { apiKey: 'tvly-test' },
    );

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(result.meta.rewritten, false);
    assert.equal(body.query, result.query);
  });

  test('understand=false skips the intent block', async () => {
    mockProvider(TAVILY_PAYLOAD);
    const result = await runPipeline(
      { query: 'what is MCP', understand: false },
      { apiKey: 'tvly-test' },
    );
    assert.equal(result.intent, undefined);
  });

  test('detects a Spanish query and resolves the language', async () => {
    mockProvider(TAVILY_PAYLOAD);
    const result = await runPipeline({ query: '¿Qué es el protocolo de contexto de modelo?' }, { apiKey: 'tvly-test' });

    assert.equal(result.language.requested, 'auto');
    assert.equal(result.language.resolved, 'es');
    assert.equal(result.language.detected.language, 'es');
  });

  test('an explicit language overrides detection', async () => {
    mockProvider(TAVILY_PAYLOAD);
    const result = await runPipeline({ query: 'que es MCP', language: 'pt-BR' }, { apiKey: 'tvly-test' });
    assert.equal(result.language.resolved, 'pt');
  });

  test('reports params the provider silently drops', async () => {
    // Exa has no language parameter.
    const calls = mockProvider({ results: [] });
    const result = await runPipeline(
      { query: 'protocolo de contexto', provider: 'exa', language: 'es' },
      { apiKey: 'exa-test' },
    );

    assert.ok(
      result.unsupported_params?.includes('language'),
      `unsupported_params was ${JSON.stringify(result.unsupported_params)}`,
    );
    assert.equal(calls[0].url, 'https://api.exa.ai/search');
  });

  test('integrates configured secondary keys into one federated pipeline result', async () => {
    const keys = ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY', 'XWEB_SEARCH_API_KEY', 'XWEB_SEARCH_PROVIDER'] as const;
    const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const previousFetch = globalThis.fetch;
    for (const key of keys) delete process.env[key];
    process.env.BRAVE_API_KEY = 'brave-secondary';
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      const payload = url.includes('brave')
        ? { web: { results: [{ title: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/?utm_source=brave', description: 'An open protocol for connecting AI systems with tools.' }] } }
        : TAVILY_PAYLOAD;
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const result = await runPipeline({ query: 'MCP protocol', understand: false }, { apiKey: 'tvly-primary' });
      assert.equal(calls.length, 2);
      assert.deepEqual(result.providers_used, ['tavily', 'brave']);
      assert.equal(result.results.find((hit) => hit.url.startsWith('https://modelcontextprotocol.io'))?.source_count, 2);
    } finally {
      globalThis.fetch = previousFetch;
      for (const key of keys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('clamps max_results into range', async () => {
    const calls = mockProvider(TAVILY_PAYLOAD);
    await runPipeline({ query: 'MCP', max_results: 999 }, { apiKey: 'tvly-test' });
    assert.equal(JSON.parse(calls[0].init.body as string).max_results, 20);

    const low = mockProvider(TAVILY_PAYLOAD);
    await runPipeline({ query: 'MCP', max_results: -4 }, { apiKey: 'tvly-test' });
    assert.equal(JSON.parse(low[0].init.body as string).max_results, 1);
  });
});

describe('pipeline validation', () => {
  test('rejects a missing query', async () => {
    await assert.rejects(() => runPipeline({}, { apiKey: 'k' }), (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'missing_query');
      return true;
    });
  });

  test('rejects unknown providers and time ranges', async () => {
    for (const [body, code] of [
      [{ query: 'x', provider: 'bing' }, 'invalid_provider'],
      [{ query: 'x', time_range: 'decade' }, 'invalid_time_range'],
      [{ query: 'x', topic: 'sport' }, 'invalid_topic'],
      [{ query: 'x', search_depth: 'deep' }, 'invalid_search_depth'],
    ] as const) {
      await assert.rejects(() => runPipeline(body, { apiKey: 'k' }), (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, code);
        return true;
      });
    }
  });

  test('rejects an over-long query', async () => {
    await assert.rejects(
      () => runPipeline({ query: 'a'.repeat(2001) }, { apiKey: 'k' }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, 'query_too_long');
        return true;
      },
    );
  });
});
