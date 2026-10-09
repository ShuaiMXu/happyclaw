import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { useAuthStore } from '../../stores/auth';
import { LogoLoading } from '../common/LogoLoading';

const MIN_BOOT_VISIBLE_MS = 180;
const AUTH_TIMEOUT_MS = 12000;

type BootPhase = 'loading' | 'exiting' | 'done';

interface AppBootGateProps {
  children: ReactNode;
  onGoToLogin?: () => void;
}

export function AppBootGate({ children, onGoToLogin }: AppBootGateProps) {
  const checking = useAuthStore((state) => state.checking);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const startedAtRef = useRef(
    typeof performance === 'undefined' ? 0 : performance.now(),
  );
  const resolvedRef = useRef(false);
  const [phase, setPhase] = useState<BootPhase>('loading');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (phase !== 'loading' || !checking) {
      setTimedOut(false);
      return;
    }

    const timer = window.setTimeout(() => setTimedOut(true), AUTH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [checking, phase]);

  useEffect(() => {
    if (phase !== 'loading' || checking || resolvedRef.current) return;
    resolvedRef.current = true;

    const elapsed =
      (typeof performance === 'undefined' ? 0 : performance.now()) -
      startedAtRef.current;
    const delay = Math.max(0, MIN_BOOT_VISIBLE_MS - elapsed);
    const timer = window.setTimeout(() => setPhase('exiting'), delay);
    return () => window.clearTimeout(timer);
  }, [checking, phase]);

  return (
    <>
      {children}
      {phase !== 'done' && (
        <div
          data-app-boot-overlay="true"
          className="fixed inset-0 z-[100] bg-background"
        >
          {timedOut ? (
            <div className="flex min-h-screen items-center justify-center bg-background p-6">
              <Card className="max-w-md text-center">
                <CardContent>
                  <h2 className="mb-2 text-lg font-semibold text-foreground">
                    页面初始化超时
                  </h2>
                  <p className="mb-4 text-sm text-muted-foreground">
                    后端可能刚启动或浏览器缓存异常，请先刷新页面；若仍失败，重新登录。
                  </p>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary/90"
                    >
                      刷新页面
                    </button>
                    {onGoToLogin && (
                      <button
                        type="button"
                        onClick={() => {
                          setPhase('done');
                          onGoToLogin();
                        }}
                        className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
                      >
                        去登录页
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <LogoLoading
              full
              exiting={phase === 'exiting'}
              onExitComplete={() => setPhase('done')}
            />
          )}
        </div>
      )}
    </>
  );
}
