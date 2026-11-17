import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import {
  apply as applyHost,
  repairJson,
  StreamPatternExtractor,
  genPrompt,
  type SuperagentGenuiService,
} from '../../src/genui/index.js';
import {
  createGenuiClientRegistry,
  installGenuiClientRegistry,
  type SuperagentGenuiClientService,
} from '../../src/client/genui-client-registry.js';

test('repairJson repairs truncated streaming SchemaJson payloads', () => {
  const partial =
    '```schema-json\n{"componentName":"GenuiCard","props":{"title":"今日工作简报","badge":"早报"},"children":[{"componentName":"DshMetricGroup","props":{"items":[{"label":"今日待办","value":3';
  const repaired = JSON.parse(repairJson(partial)) as {
    componentName: string;
    props: { title: string };
    children: { componentName: string; props: { items: { value: number }[] } }[];
  };
  assert.equal(repaired.componentName, 'GenuiCard');
  assert.equal(repaired.props.title, '今日工作简报');
  assert.equal(repaired.children[0]!.componentName, 'DshMetricGroup');
  assert.equal(repaired.children[0]!.props.items[0]!.value, 3);
});

test('StreamPatternExtractor extracts incomplete and complete schema-json blocks', () => {
  const extractor = new StreamPatternExtractor();
  let chunks = extractor.handleContent('先看结论：\n```schema-json\n{"componentName":"GenuiCard"');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.isComplete, false);

  chunks = extractor.handleContent(',"props":{"title":"完成"}}\n```\n后续说明');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.isComplete, true);
  assert.deepEqual(JSON.parse(chunks[0]!.content), {
    componentName: 'GenuiCard',
    props: { title: '完成' },
  });
});

test('superagentGenui host service registers and disposes custom MaterialMeta and generates prompt', () => {
  let providedName: string | null = null;
  let providedService: SuperagentGenuiService | null = null;
  const cleanups: (() => void)[] = [];
  const fakeCtx = {
    effect(fn: () => () => void) {
      cleanups.push(fn());
    },
    provide(name: string, service: SuperagentGenuiService) {
      providedName = name;
      providedService = service;
    },
  } as unknown as Context;

  applyHost(fakeCtx);
  assert.equal(providedName, 'superagentGenui');
  assert.ok(providedService);
  const svc = providedService as SuperagentGenuiService;

  const dispose = svc.registerMaterialMeta({
    componentName: 'CustomBurndownChart',
    title: '燃尽图卡片',
    category: 'display',
    description: '展示迭代剩余工时趋势。',
    propsSchema: { sprintName: 'string', points: 'number[]' },
  });

  assert.equal(svc.getMaterialsMeta().length, 1);
  const prompt = genPrompt('React', svc.getMaterialsMeta(), {
    rules: ['禁止直接执行破坏性写操作'],
  });
  assert.match(prompt, /CustomBurndownChart/);
  assert.match(prompt, /禁止直接执行破坏性写操作/);

  dispose();
  assert.equal(svc.getMaterialsMeta().length, 0);
});

test('superagentGenuiClient registry registers materials and custom actions with subscription and installs on ctx', () => {
  const registry = createGenuiClientRegistry();
  let notifications = 0;
  const unsub = registry.subscribe(() => {
    notifications += 1;
  });

  const DummyComponent = () => null;
  const disposeMat = registry.registerMaterial('CustomCard', DummyComponent);
  const disposeAct = registry.registerAction('custom.openUrl', () => {});

  assert.equal(notifications, 2);
  assert.equal(registry.getMaterials().CustomCard, DummyComponent);
  assert.equal(typeof registry.getActions()['custom.openUrl'], 'function');

  disposeMat();
  disposeAct();
  unsub();
  assert.equal(Object.keys(registry.getMaterials()).length, 0);
  assert.equal(Object.keys(registry.getActions()).length, 0);

  let clientProvided: SuperagentGenuiClientService | undefined;
  const fakeClientCtx = {
    get(name: string) {
      return name === 'superagentGenuiClient' ? clientProvided : undefined;
    },
    provide(name: string, value: SuperagentGenuiClientService) {
      if (name === 'superagentGenuiClient') clientProvided = value;
    },
  } as unknown as Context;
  installGenuiClientRegistry(fakeClientCtx);
  assert.ok(clientProvided);
  assert.equal(clientProvided.protocol, 1);
});

test('P3 cross-plugin package registration works on both Host and Client services', () => {
  let hostService: SuperagentGenuiService | null = null;
  applyHost({
    effect() {},
    provide(_name: string, svc: SuperagentGenuiService) {
      hostService = svc;
    },
  } as unknown as Context);
  assert.ok(hostService);
  const svc = hostService as SuperagentGenuiService;

  const disposeHostPkg = svc.registerPluginMaterials('@local/dsh-pomodoro-clock', [
    {
      componentName: 'PomodoroFocusRing',
      title: '番茄钟圆环',
      category: 'domain',
      description: '外部番茄钟插件注册的专注圆环卡片',
      propsSchema: { mode: 'focus | break' },
    },
  ]);

  assert.equal(svc.listPlugins().length, 1);
  assert.deepEqual(svc.listPlugins()[0], {
    pluginId: '@local/dsh-pomodoro-clock',
    components: ['PomodoroFocusRing'],
  });
  assert.equal(svc.getMaterialsMeta().length, 1);

  const clientRegistry = createGenuiClientRegistry();
  const FocusRingComp = () => null;
  const disposeClientPkg = clientRegistry.registerPluginPackage({
    id: '@local/dsh-pomodoro-clock',
    materials: { PomodoroFocusRing: FocusRingComp },
    actions: { 'pomodoro.ring.ding': () => {} },
  });

  assert.equal(clientRegistry.listPlugins().length, 1);
  assert.deepEqual(clientRegistry.listPlugins()[0], {
    id: '@local/dsh-pomodoro-clock',
    materials: ['PomodoroFocusRing'],
    actions: ['pomodoro.ring.ding'],
  });
  assert.equal(clientRegistry.getMaterials().PomodoroFocusRing, FocusRingComp);

  disposeHostPkg();
  disposeClientPkg();
  assert.equal(svc.listPlugins().length, 0);
  assert.equal(clientRegistry.listPlugins().length, 0);
});
