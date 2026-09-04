import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';
import { APP_BASE } from '../../utils/url';

interface LogoLoadingProps {
  /** Show full animated logo with wordmark */
  full?: boolean;
  /** Size of the icon-only variant (default 64) */
  size?: number;
  /** Optional label below the logo */
  label?: string;
  /**
   * Play the boot-complete exit flourish (pop to 105%, then collapse to a
   * single pixel within 0.3s) instead of the idle loading pulse. Fires
   * `onExitComplete` once the animation finishes so the caller can swap in
   * the real content.
   */
  exiting?: boolean;
  onExitComplete?: () => void;
}

/**
 * Animated loading screen with the SoftopiaAI mark.
 * - `full` mode: full-screen boot/auth-check placeholder.
 * - default: inline icon with a subtle pulse, for smaller loading states.
 *
 * The icon is admin-configurable (Settings → 外观 → 加载动画图标); this
 * renders before login on the very first paint, so it reads the appearance
 * config straight from the store rather than fetching. The store's initial
 * value comes from `window.__appearancePrewarm` (embedded server-side in
 * `index.html`, see `src/index-html-template.ts`), so it's already correct
 * on this very first render — no flash of the built-in default mark while
 * waiting on a fetch. Falls back to the built-in mark only if nothing is
 * configured at all.
 */
export function LogoLoading({
  full,
  size = 64,
  label,
  exiting,
  onExitComplete,
}: LogoLoadingProps) {
  const brandLoadingIconUrl = useAuthStore(
    (s) => s.appearance?.brandLoadingIconUrl,
  );
  const src = brandLoadingIconUrl || `${APP_BASE}icons/loading-mark.png`;
  const iconClassName = cn(
    exiting ? 'hc-boot-exit' : 'animate-pulse',
    'object-contain',
  );
  const handleAnimationEnd = exiting ? onExitComplete : undefined;

  if (full) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center">
        <img
          src={src}
          alt="SoftopiaAI"
          className={cn(iconClassName, 'w-[min(36vw,160px)] h-auto')}
          onAnimationEnd={handleAnimationEnd}
        />
        {label && <p className="mt-6 text-sm text-muted-foreground">{label}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <img
        src={src}
        alt="SoftopiaAI"
        className={iconClassName}
        style={{ width: size, height: size }}
        onAnimationEnd={handleAnimationEnd}
      />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
