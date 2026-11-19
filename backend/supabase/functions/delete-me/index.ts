import { readEnv } from '../_shared/env.ts';
import { handleDeleteMe } from './handler.ts';

Deno.serve((req) => handleDeleteMe(req, readEnv(), fetch));
