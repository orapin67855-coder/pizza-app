import { readEnv } from '../_shared/env.ts';
import { handleCareLinks } from './handler.ts';

Deno.serve((req) => handleCareLinks(req, readEnv(), fetch));
