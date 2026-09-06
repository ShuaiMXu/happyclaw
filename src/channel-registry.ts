/**
 * Lazy implementation registry for optional IM providers.
 *
 * Keep this module dependency-light: importing channel contracts or the
 * connection manager must not initialize every third-party provider SDK.
 * Implementations are loaded only when a concrete channel connects.
 */

export interface ChannelImplementationModules {
  feishu: typeof import('./feishu.js');
  telegram: typeof import('./telegram.js');
  qq: typeof import('./qq.js');
  wechat: typeof import('./wechat.js');
  wecom: typeof import('./wecom.js');
  dingtalk: typeof import('./dingtalk.js');
  discord: typeof import('./discord.js');
  whatsapp: typeof import('./whatsapp.js');
}

export type LoadableChannelProvider = keyof ChannelImplementationModules;

type ChannelImplementationLoaders = {
  [K in LoadableChannelProvider]: () => Promise<
    ChannelImplementationModules[K]
  >;
};

const defaultLoaders: ChannelImplementationLoaders = {
  feishu: () => import('./feishu.js'),
  telegram: () => import('./telegram.js'),
  qq: () => import('./qq.js'),
  wechat: () => import('./wechat.js'),
  wecom: () => import('./wecom.js'),
  dingtalk: () => import('./dingtalk.js'),
  discord: () => import('./discord.js'),
  whatsapp: () => import('./whatsapp.js'),
};

const loaders = new Map<LoadableChannelProvider, () => Promise<unknown>>(
  Object.entries(defaultLoaders) as Array<
    [LoadableChannelProvider, () => Promise<unknown>]
  >,
);
const modulePromises = new Map<LoadableChannelProvider, Promise<unknown>>();

export function loadChannelImplementation<K extends LoadableChannelProvider>(
  provider: K,
): Promise<ChannelImplementationModules[K]> {
  const current = modulePromises.get(provider);
  if (current) {
    return current as Promise<ChannelImplementationModules[K]>;
  }

  const pending = loaders.get(provider)!().catch((error) => {
    if (modulePromises.get(provider) === pending) {
      modulePromises.delete(provider);
    }
    throw error;
  });
  modulePromises.set(provider, pending);
  return pending as Promise<ChannelImplementationModules[K]>;
}

/** Test seam for proving lazy, provider-local loading without importing SDKs. */
export function setChannelImplementationLoaderForTest<
  K extends LoadableChannelProvider,
>(
  provider: K,
  loader: () => Promise<ChannelImplementationModules[K]>,
): () => void {
  const previous = loaders.get(provider)!;
  const previousModule = modulePromises.get(provider);
  loaders.set(provider, loader);
  modulePromises.delete(provider);
  return () => {
    loaders.set(provider, previous);
    if (previousModule) modulePromises.set(provider, previousModule);
    else modulePromises.delete(provider);
  };
}
