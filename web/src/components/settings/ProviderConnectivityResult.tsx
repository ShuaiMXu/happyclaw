import { CheckCircle2, CircleX } from 'lucide-react';

export interface ProviderConnectivityProbe {
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  message?: string;
  hint?: string;
}

export interface ProviderConnectivityResponse {
  ok: boolean;
  probes: ProviderConnectivityProbe[];
}

/** Outcome of POST /api/config/claude/providers/test, one row per model. */
export function ProviderConnectivityResult({
  result,
}: {
  result: ProviderConnectivityResponse;
}) {
  return (
    <div
      role="status"
      className="space-y-1.5 rounded-lg px-3 py-2.5 ring-1 ring-surface-border"
    >
      {result.probes.map((probe) => (
        <div key={probe.model} className="flex items-start gap-2">
          {probe.ok ? (
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0 text-success"
              aria-hidden="true"
            />
          ) : (
            <CircleX
              className="mt-0.5 size-4 shrink-0 text-error"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0 text-caption leading-5">
            <div className="text-foreground">
              <span className="font-mono">{probe.model}</span>
              {' · '}
              {probe.ok
                ? `连接成功（${probe.latencyMs} ms）`
                : probe.status === null
                  ? '连接失败'
                  : `HTTP ${probe.status}`}
            </div>
            {probe.hint && (
              <div className="text-muted-foreground">{probe.hint}</div>
            )}
            {probe.message && (
              <div className="font-mono text-micro break-all text-faint-foreground">
                {probe.message}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
