import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  isRouteRestoreEnabled,
  saveLastRoute,
  getLastRoute,
} from '../utils/routeRestore';

// Paths that count as "fresh app launch" — a PWA cold start lands on the
// manifest start_url (`/chat`). When the user opens a deep link directly we
// honor it instead of overriding with the saved route.
const RESTORE_TRIGGER_PATHS = new Set(['/chat', '/']);

// This feature is documented (Settings → 偏好设置 → "恢复上次页面") as PWA-only
// ("再次打开 PWA 时回到上次访问的页面"), but nothing previously checked that —
// it fired on every ordinary browser tab too, so a fresh tab could land
// straight in whatever workspace was last open instead of the workspace
// list. Gate both effects on actually running in standalone/installed mode.
function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari doesn't support the display-mode media query the same way;
  // it exposes this legacy boolean instead once launched from a home-screen
  // icon.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

export function useRouteRestore(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    if (!isStandalonePwa()) return;
    if (!isRouteRestoreEnabled()) return;
    if (!RESTORE_TRIGGER_PATHS.has(location.pathname)) return;

    const saved = getLastRoute();
    if (!saved) return;

    const currentFull = location.pathname + location.search;
    if (saved === currentFull) return;

    navigate(saved, { replace: true });
    // Run only on initial mount; subsequent location changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isStandalonePwa()) return;
    if (!isRouteRestoreEnabled()) return;
    saveLastRoute(location.pathname + location.search);
  }, [location.pathname, location.search]);
}
