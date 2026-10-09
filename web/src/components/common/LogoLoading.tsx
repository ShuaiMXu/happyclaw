import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';
import { withBasePath } from '../../utils/url';

const IMAGE_READY_TIMEOUT_MS = 1500;
const EXIT_FALLBACK_TIMEOUT_MS = 650;

interface LogoLoadingProps {
  /** Show full animated logo with wordmark */
  full?: boolean;
  /** Size of the icon-only variant (default 64) */
  size?: number;
  /** Optional label below the logo */
  label?: string;
  /**
   * Play the boot-complete exit flourish (pop to 105%, then collapse to a
   * single pixel within 0.45s) instead of the idle loading pulse. Fires
   * `onExitComplete` once the animation finishes so the caller can swap in
   * the real content.
   */
  exiting?: boolean;
  onExitComplete?: () => void;
}

/**
 * Animated loading screen with the configured site mark.
 * - `full` mode: full-screen boot/auth-check placeholder.
 * - default: inline icon with a subtle pulse, for smaller loading states.
 *
 * The icon is admin-configurable (Settings → 外观 → 加载动画图标); this
 * renders before login on the very first paint, so it reads the appearance
 * config straight from the store rather than fetching. The store's initial
 * value comes from `window.__appearancePrewarm` (embedded server-side in
 * `index.html`, see `src/index-html-template.ts`), so it's already correct
 * on this very first render — no flash of the built-in default mark while
 * waiting on a fetch.
 */
export function LogoLoading({
  full,
  size = 64,
  label,
  exiting,
  onExitComplete,
}: LogoLoadingProps) {
  const appearance = useAuthStore((state) => state.appearance);
  const fallbackSrc = withBasePath('/icons/loading-mark.png');
  const configuredSrc = appearance?.brandLoadingIconUrl
    ? withBasePath(appearance.brandLoadingIconUrl)
    : null;
  const desiredSrc = configuredSrc || fallbackSrc;
  const [activeSrc, setActiveSrc] = useState(desiredSrc);
  const [imageReady, setImageReady] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const decodeAttemptRef = useRef(0);
  const exitCompletedRef = useRef(false);
  const onExitCompleteRef = useRef(onExitComplete);

  useEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  }, [onExitComplete]);

  useEffect(() => {
    decodeAttemptRef.current += 1;
    setActiveSrc(desiredSrc);
    setImageReady(false);
  }, [desiredSrc]);

  const markImageReady = useCallback((image: HTMLImageElement) => {
    const attempt = ++decodeAttemptRef.current;
    const decode = image.decode?.bind(image);
    if (!decode) {
      setImageReady(true);
      return;
    }

    void decode()
      .catch(() => undefined)
      .then(() => {
        if (
          decodeAttemptRef.current === attempt &&
          imageRef.current === image
        ) {
          setImageReady(true);
        }
      });
  }, []);

  const handleImageError = useCallback(() => {
    decodeAttemptRef.current += 1;
    if (activeSrc !== fallbackSrc) {
      setActiveSrc(fallbackSrc);
      setImageReady(false);
      return;
    }

    // Even a missing built-in asset must not trap the application behind the
    // boot overlay. The reserved square can still perform the exit transition.
    setImageReady(true);
  }, [activeSrc, fallbackSrc]);

  useEffect(() => {
    if (!exiting || imageReady) return;

    const timer = window.setTimeout(() => {
      if (activeSrc !== fallbackSrc) {
        decodeAttemptRef.current += 1;
        setActiveSrc(fallbackSrc);
        setImageReady(false);
      } else {
        setImageReady(true);
      }
    }, IMAGE_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [activeSrc, exiting, fallbackSrc, imageReady]);

  const completeExit = useCallback(() => {
    if (exitCompletedRef.current) return;
    exitCompletedRef.current = true;
    onExitCompleteRef.current?.();
  }, []);

  const exitActive = Boolean(exiting && imageReady);

  useEffect(() => {
    if (!exiting) {
      exitCompletedRef.current = false;
      return;
    }
    if (!exitActive) return;

    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const timer = window.setTimeout(
      completeExit,
      reducedMotion ? 0 : EXIT_FALLBACK_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [completeExit, exitActive, exiting]);

  const iconClassName = cn(
    exitActive ? 'hc-boot-exit' : 'animate-pulse',
    'object-contain',
  );
  const image = (
    <img
      ref={imageRef}
      src={activeSrc}
      alt={appearance?.appName || 'SoftopiaAI'}
      className={
        full ? cn(iconClassName, 'size-[min(36vw,160px)]') : iconClassName
      }
      style={full ? undefined : { width: size, height: size }}
      onLoad={(event) => markImageReady(event.currentTarget)}
      onError={handleImageError}
      onAnimationEnd={exitActive ? completeExit : undefined}
    />
  );

  if (full) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background text-foreground">
        {image}
        {label && <p className="mt-6 text-sm text-muted-foreground">{label}</p>}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
      {image}
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
