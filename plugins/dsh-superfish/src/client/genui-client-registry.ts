import type { Context } from '@deepseek-ai/cordis';

export interface SuperagentGenuiClientPluginPackage {
  readonly id: string;
  readonly materials?: Readonly<Record<string, unknown>>;
  readonly actions?: Readonly<
    Record<string, (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>>
  >;
}

export interface SuperagentGenuiClientService {
  readonly protocol: 1;
  registerMaterial(name: string, component: unknown): () => void;
  registerAction(
    name: string,
    handler: (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>,
  ): () => void;
  registerPluginPackage(pkg: SuperagentGenuiClientPluginPackage): () => void;
  getMaterials(): Readonly<Record<string, unknown>>;
  getActions(): Readonly<
    Record<string, (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>>
  >;
  listPlugins(): readonly {
    readonly id: string;
    readonly materials: readonly string[];
    readonly actions: readonly string[];
  }[];
  subscribe(listener: () => void): () => void;
}

const VALID_COMPONENT_NAME = /^[A-Z][A-Za-z0-9_]{1,63}$/;
const VALID_ACTION_NAME = /^[a-z][a-zA-Z0-9_.]*$/;

export function createGenuiClientRegistry(): SuperagentGenuiClientService {
  const materials = new Map<string, unknown>();
  const actions = new Map<
    string,
    (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>
  >();
  const plugins = new Map<
    string,
    {
      readonly id: string;
      readonly materials: readonly string[];
      readonly actions: readonly string[];
    }
  >();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 忽略单个订阅者异常
      }
    }
  };

  return {
    protocol: 1,
    registerMaterial(name, component) {
      if (
        typeof name !== 'string' ||
        !VALID_COMPONENT_NAME.test(name) ||
        typeof component !== 'function'
      ) {
        throw Error('GENUI_CLIENT_MATERIAL_INVALID');
      }
      materials.set(name, component);
      notify();
      return () => {
        if (materials.get(name) === component) {
          materials.delete(name);
          notify();
        }
      };
    },
    registerAction(name, handler) {
      if (
        typeof name !== 'string' ||
        !VALID_ACTION_NAME.test(name) ||
        typeof handler !== 'function'
      ) {
        throw Error('GENUI_CLIENT_ACTION_INVALID');
      }
      actions.set(name, handler);
      notify();
      return () => {
        if (actions.get(name) === handler) {
          actions.delete(name);
          notify();
        }
      };
    },
    registerPluginPackage(pkg) {
      if (!pkg || typeof pkg !== 'object' || typeof pkg.id !== 'string' || !pkg.id.trim()) {
        throw Error('GENUI_CLIENT_PLUGIN_PACKAGE_INVALID');
      }
      const pluginId = pkg.id.trim();
      const matEntries = Object.entries(pkg.materials || {});
      const actEntries = Object.entries(pkg.actions || {});
      for (const [name, comp] of matEntries) {
        if (!VALID_COMPONENT_NAME.test(name) || typeof comp !== 'function') {
          throw Error('GENUI_CLIENT_MATERIAL_INVALID');
        }
      }
      for (const [name, fn] of actEntries) {
        if (!VALID_ACTION_NAME.test(name) || typeof fn !== 'function') {
          throw Error('GENUI_CLIENT_ACTION_INVALID');
        }
      }
      for (const [name, comp] of matEntries) {
        materials.set(name, comp);
      }
      for (const [name, fn] of actEntries) {
        actions.set(name, fn);
      }
      plugins.set(
        pluginId,
        Object.freeze({
          id: pluginId,
          materials: Object.freeze(matEntries.map(([name]) => name)),
          actions: Object.freeze(actEntries.map(([name]) => name)),
        }),
      );
      notify();
      return () => {
        for (const [name, comp] of matEntries) {
          if (materials.get(name) === comp) {
            materials.delete(name);
          }
        }
        for (const [name, fn] of actEntries) {
          if (actions.get(name) === fn) {
            actions.delete(name);
          }
        }
        plugins.delete(pluginId);
        notify();
      };
    },
    getMaterials() {
      return Object.fromEntries(materials.entries());
    },
    getActions() {
      return Object.fromEntries(actions.entries());
    },
    listPlugins() {
      return [...plugins.values()];
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function installGenuiClientRegistry(ctx: Context): void {
  const runtime = ctx as unknown as {
    get?(name: string): unknown;
    provide?(name: string, value: unknown): void;
    reflect?: { provide?(name: string, value: unknown): () => void };
    effect?(fn: () => void | (() => void)): void;
  };
  if (typeof runtime.get === 'function' && runtime.get('superagentGenuiClient')) {
    return;
  }
  const registry = createGenuiClientRegistry();
  if (typeof runtime.reflect?.provide === 'function' && typeof runtime.effect === 'function') {
    runtime.effect(() => runtime.reflect!.provide!('superagentGenuiClient', registry));
  } else if (typeof runtime.provide === 'function') {
    runtime.provide('superagentGenuiClient', registry);
  }
}

export function apply(ctx: Context): void {
  installGenuiClientRegistry(ctx);
}
