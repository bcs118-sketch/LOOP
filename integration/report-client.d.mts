export class ReportApiError extends Error {
  code: string;
  status: number;
  uncertain: boolean;
  constructor(code: string, message: string, options?: { status?: number; uncertain?: boolean });
}
export interface PreparedDraft {
  readonly input: Readonly<Record<string, unknown>>;
  readonly request_id: string;
}
export interface RequestOptions { signal?: AbortSignal }
export function prepareDraft(input: object, requestId?: string): PreparedDraft;
export function validatePhoto(file: Blob): Promise<{ mime: string; extension: string; size: number }>;
export class ReportClient {
  constructor(options?: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number });
  capabilities(options?: RequestOptions): Promise<unknown>;
  session(options?: RequestOptions): Promise<unknown>;
  listReports(options?: RequestOptions): Promise<unknown>;
  getReport(id: string, options?: RequestOptions): Promise<unknown>;
  saveDraft(prepared: PreparedDraft, options?: RequestOptions & { locationConfirmed?: boolean }): Promise<unknown>;
  editReport(id: string, input: object, version: number, options?: RequestOptions & { locationConfirmed?: boolean }): Promise<unknown>;
  uploadPhoto(id: string, file: Blob, version: number, options?: RequestOptions): Promise<unknown>;
  approveHandoff(id: string, version: number, options?: RequestOptions & { consent?: boolean }): Promise<unknown>;
  getPacket(id: string, options?: RequestOptions & { format?: 'json' | 'text' }): Promise<unknown>;
}
