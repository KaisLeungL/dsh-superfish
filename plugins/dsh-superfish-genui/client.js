/**
 * @local/dsh-superfish-genui/client - 浏览器端 GenUI 物料与受控动作注册中心
 *
 * 为超级大肥鱼 (@local/dsh-superfish) 的 <GenuiConfigProvider /> 与 <GenuiRenderer />
 * 提供插件级动态扩展点：第三方插件可通过 ctx.get('superagentGenuiClient') 动态注册自定义
 * React 物料组件或受控 customActions。
 */

const VALID_COMPONENT_NAME = /^[A-Z][A-Za-z0-9_]{1,63}$/;
const VALID_ACTION_NAME = /^[a-z][a-zA-Z0-9_.]*$/;

export function createGenuiClientRegistry() {
  const materials = new Map();
  const actions = new Map();
  const plugins = new Map();
  const listeners = new Set();

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
      if (typeof name !== 'string' || !VALID_COMPONENT_NAME.test(name) || typeof component !== 'function') {
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
      if (typeof name !== 'string' || !VALID_ACTION_NAME.test(name) || typeof handler !== 'function') {
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

export function apply(ctx) {
  const registry = createGenuiClientRegistry();
  if (typeof ctx?.provide === 'function') {
    ctx.provide('superagentGenuiClient', registry);
  }
}
