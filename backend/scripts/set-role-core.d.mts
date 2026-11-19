export type AppRole = 'patient' | 'carer' | 'physio' | 'admin';

export function parseArgs(argv: readonly string[]): { email: string; role: AppRole };

export function assertLocalApi(apiUrl: string): void;

export function setRole(
  deps: { api: string; serviceKey: string; fetchFn: typeof fetch },
  email: string,
  role: AppRole,
): Promise<{ id: string; role: AppRole }>;
