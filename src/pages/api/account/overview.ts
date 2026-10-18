import type { APIContext } from 'astro';
import { authenticateAccountUser, AccountAuthError } from '../../../lib/account.ts';
import { errorResponse, internalError, json } from '../../../lib/http.ts';

export const prerender = false;

export async function GET({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [profileResult, keysResult, usageCountResult, recentResult] = await Promise.all([
      admin.from('profiles').select('email, full_name').eq('id', user.id).maybeSingle(),
      admin.from('api_keys').select('id, name, prefix, created_at, last_used_at').eq('user_id', user.id).is('revoked_at', null).order('created_at', { ascending: false }),
      admin.from('usage_events').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', monthStart.toISOString()),
      admin.from('usage_events').select('id, endpoint, provider, result_count, duration_ms, created_at').eq('user_id', user.id).gte('created_at', monthStart.toISOString()).order('created_at', { ascending: false }).limit(20),
    ]);

    const error = profileResult.error ?? keysResult.error ?? usageCountResult.error ?? recentResult.error;
    if (error) return internalError('Could not load account data. Verify the Supabase database migration has been applied.', 'account_data_unavailable');

    return json({
      profile: {
        email: profileResult.data?.email ?? user.email ?? null,
        full_name: profileResult.data?.full_name ?? user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
      },
      keys: keysResult.data ?? [],
      usage: {
        requests_this_month: usageCountResult.count ?? 0,
        month_label: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        recent: recentResult.data ?? [],
      },
    });
  } catch (error) {
    if (error instanceof AccountAuthError) return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
    return internalError('Could not load account data.');
  }
}
