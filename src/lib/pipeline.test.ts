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
      { query: 'what is the model context protocol', include_answer: true },
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

  test('uses a saved per-account provider key when no deployment key is available', async () => {
    const calls = mockProvider({ web: { results: [{ title: 'Purple flowers', url: 'https://example.com/flowers', description: 'A guide to flowers.' }] } });
    const result = await runPipeline(
      { query: 'purple flowers', provider: 'brave', understand: false },
      { providerKeys: { brave: 'account-brave-secret' } },
    );
    assert.equal(result.providers_used[0], 'brave');
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(url.searchParams.get('q'), 'purple flowers');
    assert.equal(url.searchParams.get('count'), '5');
    assert.equal(new Headers(calls[0].init.headers).get('X-Subscription-Token'), 'account-brave-secret');
  });

  test('chooses an available saved provider when mode is standard and none is explicitly selected', async () => {
    const calls = mockProvider({ web: { results: [{ title: 'MCP', url: 'https://example.com/mcp', description: 'Protocol overview.' }] } });
    const result = await runPipeline({ query: 'MCP', mode: 'standard' }, { providerKeys: { brave: 'brave-account-key' } });
    assert.equal(result.provider, 'brave');
    assert.equal(calls.length, 1);
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

  test('deep mode plans queries, searches concurrently, extracts pages and returns a BYOK report', async () => {
    const previousFetch = globalThis.fetch;
    const aiCalls: any[] = [];
    const providerQueries: string[] = [];
    const aiConfig = { provider: 'openai' as const, model: 'test-model', apiKey: 'byok-secret', source: 'byok' as const };
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes('api.openai.com')) {
        const body = JSON.parse(String(init.body));
        aiCalls.push(body);
        const system = body.messages?.[0]?.content ?? body.system ?? '';
        const content = String(system).includes('citation entailment reviewer')
          ? JSON.stringify({ results: [{ id: 1, verdict: 'supported', quote: 'It defines a structured way for systems to communicate and exchange context.' }] })
          : String(system).includes('research planner')
            ? JSON.stringify({ queries: ['MCP architecture and protocol', 'MCP adoption and security'] })
            : '## Overview\nThe Model Context Protocol standardizes connections between AI applications and tools [1].\n## Key findings\nThis standard lets separate software components exchange contextual information through a shared interface [2].';
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('api.tavily.com')) {
        const body = JSON.parse(String(init.body));
        providerQueries.push(body.query);
        return new Response(JSON.stringify({ results: [{ title: `Source for ${body.query}`, url: `https://modelcontextprotocol.io/research/${providerQueries.length}`, content: 'The Model Context Protocol is an open standard connecting AI applications with tools and data sources.' }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://modelcontextprotocol.io/research/')) {
        return new Response('<html><title>Research source</title><article><p>The Model Context Protocol is an open standard connecting AI applications with tools and data sources. It defines a structured way for systems to communicate and exchange context.</p></article></html>', { headers: { 'Content-Type': 'text/html' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;
    try {
      const result = await runPipeline({ query: 'Research the Model Context Protocol', mode: 'deep' }, {
        providerKeys: { tavily: 'tvly-saved' }, aiConfig, semanticCitationCheck: true,
      });
      assert.deepEqual(providerQueries, ['Research the Model Context Protocol', 'MCP architecture and protocol', 'MCP adoption and security']);
      assert.equal(aiCalls.length, 3, 'the saved BYOK model should plan, write the report, and review flagged citations once');
      assert.equal(result.mode, 'deep');
      assert.equal(result.meta.research?.mode, 'deep');
      assert.equal(result.report, result.answer?.text);
      assert.ok(result.citations?.length);
      assert.equal(result.meta.research?.subqueries.length, 3);
      assert.equal(result.meta.research?.pages_read, 3);
      assert.equal(result.answer?.format, 'markdown_report');
      assert.match(result.answer?.text ?? '', /## Key findings/);
      assert.equal(result.answer?.ai_key_source, 'byok');
      assert.ok(result.answer?.citations.length);
      assert.equal(result.answer?.citation_verification?.method, 'lexical_plus_semantic');
      assert.equal(result.answer?.citation_verification?.semantic_checked_claims, 1);
      assert.equal(result.answer?.citation_verification?.semantic_supported_claims, 1);
      assert.equal(result.results.length, 3);
    } finally {
      globalThis.fetch = previousFetch;
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

  test('requires the caller saved AI BYOK key for deep mode', async () => {
    await assert.rejects(() => runPipeline({ query: 'research', mode: 'deep' }, { apiKey: 'tvly-test' }), (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.code, 'deep_mode_requires_ai_key');
      return true;
    });
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
