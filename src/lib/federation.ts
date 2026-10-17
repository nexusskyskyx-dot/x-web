/** Parallel provider fan-out with partial-failure tolerance and best-of-all ranking. */

import { env } from './env.ts';
import {
  PROVIDERS,
  PROVIDER_META,
  PROVIDER_CAPABILITIES,
  isProvider,
  SearchError,
  runSearch,
  type ProviderId,
  type SearchRequest,
  type SearchResponse,
} from './search.ts';
import { rankAndBlend } from './ranking.ts';

export interface ProviderFailure {
  provider: ProviderId;
  message: string;
  status?: number;
}

export interface FederatedSearchResponse extends SearchResponse {
  provider: string;
  providers_used: ProviderId[];
  provider_errors?: ProviderFailure[];
  unavailable_providers?: ProviderId[];
}

export interface FederatedOptions {
  apiBase?: string;
  primaryProvider: ProviderId;
  primaryKey: string;
  multiSource?: boolean;
  explicitLanguage?: boolean;
  requestedProviders?: ProviderId[];
  /** Test seam; production keys are read from provider-specific env vars. */
  providerKeys?: Partial<Record<ProviderId, string>>;
}

export async function searchAcrossProviders(
  request: SearchRequest,
  options: FederatedOptions,
): Promise<FederatedSearchResponse> {
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const provider of PROVIDERS) {
    const key = options.providerKeys?.[provider] ?? env(PROVIDER_META[provider].envVar);
    if (key) keys[provider] = key;
  }

  // The caller's key is bound only to the provider selected for this request.
  if (options.primaryKey) keys[options.primaryProvider] = options.primaryKey;

  // Generic site key is only safe to reuse for the configured default provider.
  const configuredDefault = env('XWEB_SEARCH_PROVIDER');
  const genericKey = env('XWEB_SEARCH_API_KEY');
  if (genericKey && isProvider(configuredDefault) && !keys[configuredDefault]) {
    keys[configuredDefault] = genericKey;
  } else if (genericKey && !isProvider(configuredDefault) && !keys[options.primaryProvider]) {
    keys[options.primaryProvider] = genericKey;
  }

  // XWEB_API_BASE represents one upstream x-web API credential, not a pool of
  // raw provider credentials; keep this forwarding mode to a single call.
  const requested = options.apiBase
    ? [options.primaryProvider]
    : options.requestedProviders?.length
      ? [...new Set(options.requestedProviders)]
      : options.multiSource !== false
        ? PROVIDERS.filter((provider) => Boolean(keys[provider]))
        : [options.primaryProvider];

  // Always include the explicitly selected primary provider first when the
  // caller did not provide a hard list.
  if (!options.requestedProviders?.length && !requested.includes(options.primaryProvider) && keys[options.primaryProvider]) {
    requested.unshift(options.primaryProvider);
  }

  const selected = requested.filter((provider) => Boolean(keys[provider]));
  const unavailable = requested.filter((provider) => !keys[provider]);
  if (selected.length === 0) {
    throw new SearchError('No configured provider key is available for the requested providers.', 400, 'multi');
  }

  const settled = await Promise.allSettled(
    selected.map(async (provider) => {
      const caps = PROVIDER_CAPABILITIES[provider];
      const providerRequest: SearchRequest = {
        ...request,
        provider,
        // Adapters decide what to send. Keeping the requested values here also
        // lets them report unsupported filters honestly in the merged response.
        language: request.language,
        country: request.country,
        include_raw_content: caps.rawContent ? request.include_raw_content : false,
      };
      return { provider, response: await runSearch(keys[provider]!, providerRequest, { apiBase: options.apiBase }) };
    }),
  );

  const successful: Array<{ provider: ProviderId; response: SearchResponse }> = [];
  const failures: ProviderFailure[] = [];
  settled.forEach((result, index) => {
    const provider = selected[index];
    if (result.status === 'fulfilled') successful.push(result.value);
    else {
      const error = result.reason;
      failures.push({
        provider,
        message: error instanceof Error ? error.message : 'Provider search failed.',
        ...(typeof error?.status === 'number' ? { status: error.status } : {}),
      });
    }
  });

  if (successful.length === 0) {
    const first = settled.find((result) => result.status === 'rejected');
    if (first?.status === 'rejected') throw first.reason;
    throw new Error('All configured image search providers failed.');
  }

  const providerHits = successful.map(({ provider, response }) => ({ provider, results: response.results }));
  const maxResults = Math.min(Math.max(Math.trunc(request.max_results ?? 5), 1), 20);
  const results = rankAndBlend(request.query, providerHits, { maxResults });
  const preferred = successful.find((item) => item.provider === options.primaryProvider);
  const answerResponse = (preferred?.response.answer ? preferred : undefined) ?? successful.find((item) => item.response.answer);
  const unsupported = [...new Set(successful.flatMap((item) => item.response.unsupported_params ?? []))]
    .filter((param) => ['language', 'country', 'time_range'].includes(param))
    .filter((param) => param !== 'language' || options.explicitLanguage === true);
  const providersUsed = successful.map((item) => item.provider);

  return {
    id: `xweb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    query: request.query,
    provider: providersUsed.length > 1 ? 'multi' : providersUsed[0],
    providers_used: providersUsed,
    ...(failures.length ? { provider_errors: failures } : {}),
    ...(unavailable.length ? { unavailable_providers: unavailable } : {}),
    ...(answerResponse?.response.answer ? { answer: answerResponse.response.answer } : {}),
    results,
    took_ms: Math.max(...successful.map((item) => item.response.took_ms ?? 0)),
    ...(unsupported.length ? { unsupported_params: unsupported } : {}),
  };
}
