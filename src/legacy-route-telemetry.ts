import { logger } from './logger.js';

const routeCounts = new Map<string, number>();

function normalizeLegacyUserImPath(pathname: string): string {
  return pathname
    .replace(/\/paired-chats\/[^/]+/g, '/paired-chats/:jid')
    .replace(/\/bindings\/[^/]+/g, '/bindings/:imJid');
}

/** Aggregate compatibility-facade usage without recording users or payloads. */
export function recordLegacyUserImRoute(
  method: string,
  pathname: string,
): void {
  const route = `${method.toUpperCase()} ${normalizeLegacyUserImPath(pathname)}`;
  const count = (routeCounts.get(route) ?? 0) + 1;
  routeCounts.set(route, count);
  // Log the first use and powers of two: visible enough for migration audits
  // without turning a hot compatibility endpoint into log spam.
  if (count === 1 || (count & (count - 1)) === 0) {
    logger.info(
      { legacyRoute: route, observedCalls: count },
      'Legacy user-im compatibility route used',
    );
  }
}

export function getLegacyUserImRouteCounts(): ReadonlyMap<string, number> {
  return routeCounts;
}
