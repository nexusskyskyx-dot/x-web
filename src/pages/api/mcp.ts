import type { APIContext } from 'astro';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  AccountAuthError,
  authenticateAccountApiKey,
  createAdminClient,
  extractAccountApiKey,
  recordApiUsage,
  type AuthenticatedApiKey,
} from '../../lib/account.ts';
import { decryptProviderKeyMap, type StoredProviderCredential } from '../../lib/provider-credentials.ts';
import { decryptAiCredential, type AiCredential } from '../../lib/ai-credentials.ts';
import { runPipeline } from '../../lib/pipeline.ts';
import { clientIp, errorResponse, internalError, pruneRateLimitBuckets, rateLimit } from '../../lib/http.ts';

export const prerender = false;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const jsonError = (message: string, status: number, code: string) => {
  const response = errorResponse({
    type: status === 401 ? 'authentication_error' : 'invalid_request_error',
    code,
    message,
  }, status);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer');
  return new Response(response.body, { status: response.status, headers });
};

async function authorize(request: Request): Promise<AuthenticatedApiKey | Response> {
  const presentedKey = extractAccountApiKey(request);
  if (!presentedKey) return jsonError('Provide an x-web account key as a Bearer token.', 401, 'missing_api_key');
  try {
    return await authenticateAccountApiKey(presentedKey);
  } catch (error) {
    if (error instanceof AccountAuthError) return jsonError(error.message, error.status, error.code);
    return jsonError('Could not validate the x-web API key.', 503, 'account_service_unavailable');
  }
}

function addCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleMcp({ request, clientAddress }: APIContext): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  pruneRateLimitBuckets();
  const limit = rateLimit(clientIp(request, clientAddress));
  if (limit.limited) return addCors(errorResponse({
    type: 'rate_limit_error',
    code: 'rate_limited',
    message: 'Too many requests. Slow down and retry shortly.',
  }, 429));

  const accountKey = await authorize(request);
  if (accountKey instanceof Response) return accountKey;

  const server = new McpServer({ name: 'x-web', version: '1.0.0' });
  server.registerTool('xweb_search', {
    title: 'Search the live web with x-web',
    description: 'Search current web sources through the x-web pipeline and return a grounded answer with citations and source links.',
    inputSchema: {
      query: z.string().trim().min(1).max(500).describe('The question or topic to search for.'),
      max_results: z.number().int().min(1).max(20).optional().describe('Maximum number of web results to return (1–20).'),
      include_answer: z.boolean().optional().describe('Include an answer grounded in the search results. Defaults to true.'),
      language: z.string().max(35).optional().describe('Optional BCP-47 language tag for the answer and results.'),
      provider: z.enum(['tavily', 'brave', 'serper', 'exa']).optional().describe('Optional search provider to use.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ query, max_results, include_answer, language, provider }) => {
    try {
      const admin = createAdminClient();
      const [providerResult, aiResult] = await Promise.all([
        admin.from('provider_credentials').select('provider, encrypted_key, iv').eq('user_id', accountKey.userId),
        admin.from('ai_credentials').select('provider, model, encrypted_key, iv').eq('user_id', accountKey.userId).maybeSingle(),
      ]);
      if (providerResult.error) throw new Error('Could not load the search-provider credentials saved in your x-web dashboard.');
      const providerKeys = await decryptProviderKeyMap((providerResult.data ?? []) as StoredProviderCredential[]);
      if (Object.keys(providerKeys).length === 0) {
        throw new Error('Add a search-provider API key in your x-web dashboard before using this tool.');
      }

      let aiConfig;
      if (!aiResult.error && aiResult.data) aiConfig = await decryptAiCredential(aiResult.data as AiCredential);

      const result = await runPipeline({
        query,
        max_results,
        include_answer: include_answer ?? true,
        language,
        provider,
      }, { providerKeys, aiConfig });
      await recordApiUsage(accountKey, {
        endpoint: '/api/mcp',
        provider: result.provider,
        resultCount: result.results.length,
        durationMs: result.took_ms,
      });

      const payload = {
        query: result.query,
        answer: result.answer?.text ?? null,
        citations: result.answer?.citations ?? [],
        results: result.results.map(({ title, url, snippet, published_date }) => ({ title, url, snippet, published_date })),
        providers_used: result.providers_used,
        effective_query: result.meta.effective_query,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'x-web could not complete the search.';
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return addCors(await transport.handleRequest(request));
  } catch {
    await server.close().catch(() => undefined);
    return addCors(internalError('The x-web MCP request could not be processed.'));
  }
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
export const OPTIONS = handleMcp;
