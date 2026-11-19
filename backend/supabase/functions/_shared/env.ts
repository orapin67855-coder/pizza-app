import type { Env } from './http.ts';

/** Reads the variables Supabase injects into every Edge Function. */
export const readEnv = (): Env => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    ...(serviceKey !== undefined ? { SUPABASE_SERVICE_ROLE_KEY: serviceKey } : {}),
  };
};
