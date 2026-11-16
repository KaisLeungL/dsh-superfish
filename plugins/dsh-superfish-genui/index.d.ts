import type { Context } from '@deepseek-ai/cordis';

export interface MaterialEventMeta {
  readonly name: string;
  readonly description: string;
  readonly action: string;
}

export interface MaterialMeta {
  readonly componentName: string;
  readonly title: string;
  readonly category: 'layout' | 'domain' | 'display' | 'feedback';
  readonly description: string;
  readonly propsSchema: Readonly<Record<string, unknown>>;
  readonly allowChildren?: boolean;
  readonly events?: readonly MaterialEventMeta[];
}

export interface StreamChunk {
  readonly type: string;
  readonly content: string;
  readonly isComplete: boolean;
}

export declare class StreamPatternExtractor {
  constructor(patterns?: readonly { type: string; start: string; end: string }[]);
  handleContent(delta: string): StreamChunk[];
  snapshot(): StreamChunk[];
  reset(): void;
}

export declare function repairJson(raw: string): string;
export declare function genPrompt(
  framework: 'React' | 'Vue' | 'Angular',
  materialsMeta: readonly MaterialMeta[] | Readonly<Record<string, MaterialMeta>>,
  customConfig?: { readonly rules?: readonly string[] },
): string;

export interface SuperagentGenuiService {
  readonly protocol: 1;
  readonly repairJson: typeof repairJson;
  readonly StreamPatternExtractor: typeof StreamPatternExtractor;
  readonly genPrompt: typeof genPrompt;
  registerMaterialMeta(meta: MaterialMeta): () => void;
  registerPluginMaterials(pluginId: string, metas: readonly MaterialMeta[]): () => void;
  getMaterialsMeta(): readonly MaterialMeta[];
  listPlugins(): readonly { readonly pluginId: string; readonly components: readonly string[] }[];
}

export interface SuperagentGenuiClientPluginPackage {
  readonly id: string;
  readonly materials?: Readonly<Record<string, unknown>>;
  readonly actions?: Readonly<Record<string, (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>>>;
}

export interface SuperagentGenuiClientService {
  readonly protocol: 1;
  registerMaterial(name: string, component: unknown): () => void;
  registerAction(name: string, handler: (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>): () => void;
  registerPluginPackage(pkg: SuperagentGenuiClientPluginPackage): () => void;
  getMaterials(): Readonly<Record<string, unknown>>;
  getActions(): Readonly<Record<string, (payload?: Readonly<Record<string, unknown>>) => void | Promise<void>>>;
  listPlugins(): readonly { readonly id: string; readonly materials: readonly string[]; readonly actions: readonly string[] }[];
  subscribe(listener: () => void): () => void;
}

export declare function apply(ctx: Context, config?: { readonly materialsMeta?: readonly MaterialMeta[] }): void;
