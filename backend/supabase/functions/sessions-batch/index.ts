import { readEnv } from '../_shared/env.ts';
import { handleSessionsBatch } from './handler.ts';

Deno.serve((req) => handleSessionsBatch(req, readEnv(), fetch));
