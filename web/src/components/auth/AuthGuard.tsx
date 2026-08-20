import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { type Permission, useAuthStore } from '../../stores/auth';
import { LogoLoading } from '../common/LogoLoading';

interface AuthGuardProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requiredPermission?: Permission;
  requiredAnyPermissions?: Permission[];
}

// Module-level (not React state): the boot exit flourish should play once
// per page load, not every time an AuthGuard instance re-checks auth (e.g.
// nested guards on /monitor, /users re-flip the shared `checking` flag).
// Resets naturally on a full page reload since the module re-evaluates.
let hasPlayedBootExit = false;

export function AuthGuard({
  children,
  requireAdmin,
  requiredPermission,
  requiredAnyPermissions,
}: AuthGuardProps) {
  const {
    authenticated,
    checking,
    checkAuth,
    user,
    initialized,
    setupStatus,
    hasPermission,
  } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const checkedRef = useRef(false);
  const [timedOut, setTimedOut] = useState(false);
  // Once the first auth check resolves, briefly hold the boot screen to play
  // the exit flourish before revealing the real content underneath.
  const [bootExiting, setBootExiting] = useState(false);
  const [bootDone, setBootDone] = useState(hasPlayedBootExit);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!checking) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), 12000);
    return () => window.clearTimeout(timer);
  }, [checking]);

  useEffect(() => {
    if (checking || bootDone || bootExiting) return;
    if (hasPlayedBootExit) {
      setBootDone(true);
    } else {
      setBootExiting(true);
    }
  }, [checking, bootDone, bootExiting]);

  const handleBootExitComplete = () => {
    hasPlayedBootExit = true;
    setBootDone(true);
  };

  if (bootExiting && !bootDone) {
    return <LogoLoading full exiting onExitComplete={handleBootExitComplete} />;
  }

  if (checking) {
    if (timedOut) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-6">
          <Card className="max-w-md text-center">
            <CardContent>
              <h2 className="text-lg font-semibold text-foreground mb-2">
                页面初始化超时
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                后端可能刚启动或浏览器缓存异常，请先刷新页面；若仍失败，重新登录。
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90"
                >
                  刷新页面
                </button>
                <button
                  onClick={() => {
                    navigate('/login', { replace: true });
                  }}
                  className="px-4 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-muted"
                >
                  去登录页
                </button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }
    return <LogoLoading full />;
  }

  // System not initialized — redirect to setup page
  if (initialized === false) {
    return <Navigate to="/setup" replace />;
  }

  if (!authenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Users with must_change_password go to settings
  if (user?.must_change_password && location.pathname !== '/settings') {
    return <Navigate to="/settings" replace />;
  }

  // Admin onboarding: force provider setup flow before entering full app.
  if (
    user?.role === 'admin' &&
    setupStatus?.needsSetup &&
    location.pathname !== '/setup/providers'
  ) {
    return <Navigate to="/setup/providers" replace />;
  }

  if (requireAdmin && user?.role !== 'admin') {
    return <Navigate to="/chat" replace />;
  }

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <Navigate to="/chat" replace />;
  }

  if (requiredAnyPermissions && requiredAnyPermissions.length > 0) {
    const matched = requiredAnyPermissions.some((perm) => hasPermission(perm));
    if (!matched) return <Navigate to="/chat" replace />;
  }

  return <>{children}</>;
}
