// Minimal typing for the Deno runtime that Supabase Edge Functions run on.
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  env: { get(key: string): string | undefined };
};
