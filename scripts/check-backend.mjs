#!/usr/bin/env node
/** Public, read-only connectivity check. Never creates reports or submits to an agency. */
import { ReportClient, ReportApiError } from '../integration/report-client.mjs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/check-backend.mjs https://YOUR-EXISTING-APP-ORIGIN');
  process.exitCode = 2;
} else {
  const result = {
    checkedAt: new Date().toISOString(),
    scope: 'Unauthenticated, read-only API connectivity. Not a production readiness certification.',
    productionReady: false,
    checks: [],
    notTested: ['authenticated draft persistence', 'private photo storage', 'owner isolation',
      'real image analysis', 'report approval', 'official form filling', 'agency submission'],
  };
  try {
    const client = new ReportClient({ baseUrl: url, timeoutMs: 10000 });
    result.origin = new URL(url).origin;
    try {
      const data = await client.capabilities();
      result.checks.push({ check: 'capabilities', result: 'json_received',
        fieldNames: data && typeof data === 'object' ? Object.keys(data).slice(0, 60) : [],
        note: 'A JSON response does not prove that the advertised capabilities work.' });
    } catch (error) {
      result.checks.push({ check: 'capabilities', result: 'unreachable_or_invalid',
        code: error instanceof ReportApiError ? error.code : 'UNKNOWN_ERROR' });
      process.exitCode = 1;
    }
    try {
      await client.session();
      result.checks.push({ check: 'unauthenticated_session', result: 'json_received',
        note: 'Inspect the live session contract; this result alone does not prove authentication or a vulnerability.' });
    } catch (error) {
      result.checks.push({ check: 'unauthenticated_session', result: error.status === 401 ? 'sign_in_required' : 'not_verified',
        code: error instanceof ReportApiError ? error.code : 'UNKNOWN_ERROR' });
    }
  } catch (error) {
    result.checks.push({ check: 'configuration', result: 'invalid', code: error.code || 'UNKNOWN_ERROR' });
    process.exitCode = 2;
  }
  console.log(JSON.stringify(result, null, 2));
}
