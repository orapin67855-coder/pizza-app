import { readEnv } from '../_shared/env.ts';
import { handlePatientSummary } from './handler.ts';

Deno.serve((req) => handlePatientSummary(req, readEnv(), fetch));
