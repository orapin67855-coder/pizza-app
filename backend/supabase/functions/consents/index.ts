import { readEnv } from '../_shared/env.ts';
import { handleConsents } from './handler.ts';

Deno.serve((req) => handleConsents(req, readEnv(), fetch));
