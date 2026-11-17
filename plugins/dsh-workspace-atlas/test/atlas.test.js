import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { apply as applyHost } from '../host.js';
import { parseWorkspaceAtlas, repoPathFromRemote } from '../parser.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');

function createFixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-atlas-fixture-'));
  const extRoot = mkdtempSync(join(tmpdir(), 'dsh-atlas-ext-'));

  const repoPaths = [
    'app/gensoft/ipcs-mobile/simeji-global',
    'baidu/baiduglobalpc/facemoji-ios',
    'baidu/gensoft-ipcs-mobile/ime-android-lib',
    'baidu/facemoji-ad/TreasureBowl',
    'baidu/facemoji/facemojisdk',
    'baidu/gensoft-ipcs-mobile/ime',
    'baidu/gensoft-ipcs-mobile/gdp-facemoji-appui',
    'baidu/gensoft-ipcs-mobile/odp-facemoji-appui',
    'baidu/gensoft-ipcs-mobile/gdp-appui-library',
    'baidu/gensoft-ipcs-mobile/facemoji-python-server',
    'baidu/gensoft-ipcs-mobile/gdp-push-center',
    'baidu/gensoft-ipcs-mobile/gdp-simeji-report',
    'baidu/gensoft-ipcs-mobile/gdp-translator-pay',
    'baidu/gensoft-ipcs-mobile/gdp-simeji-ipquery',
    'baidu/gensoft-ipcs-mobile/gdp-aws-service',
  ];

  mkdirSync(join(root, 'repos', '.source', 'app', 'gensoft', 'ipcs-mobile'), { recursive: true });
  mkdirSync(join(root, 'repos', '.source', 'baidu', 'gensoft-ipcs-mobile'), { recursive: true });
  mkdirSync(join(root, 'docs', 'architecture'), { recursive: true });
  mkdirSync(join(root, 'skills', 'workspace-harness'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'android-investigator.md'), '# agent\n', 'utf8');

  writeFileSync(
    join(root, 'repos', '.repo-list'),
    repoPaths.map(p => `ssh://git@icode.baidu.com:8235/${p}`).join('\n') + '\n',
    'utf8'
  );

  // Create external targets for 2 mounted repos
  const simejiTarget = join(extRoot, 'simeji-global');
  mkdirSync(join(simejiTarget, 'LatinIME'), { recursive: true });
  writeFileSync(
    join(simejiTarget, 'LatinIME', 'gradle.properties'),
    [
      'latinIsDependOnCode=true',
      'treastureIsDependOnCode=false',
      'richIsDependOnCode=false',
    ].join('\n') + '\n',
    'utf8'
  );
  const imeLibTarget = join(extRoot, 'ime-android-lib');
  mkdirSync(imeLibTarget, { recursive: true });

  symlinkSync(
    simejiTarget,
    join(root, 'repos', '.source', 'app', 'gensoft', 'ipcs-mobile', 'simeji-global'),
    'dir'
  );
  symlinkSync(
    imeLibTarget,
    join(root, 'repos', '.source', 'baidu', 'gensoft-ipcs-mobile', 'ime-android-lib'),
    'dir'
  );

  // Profile docs for simeji-global & ime-android-lib
  const simejiProfile = join(root, 'repos', 'app', 'gensoft', 'ipcs-mobile', 'simeji-global');
  mkdirSync(simejiProfile, { recursive: true });
  writeFileSync(join(simejiProfile, 'overview.md'), '# Simeji / Facemoji Android Host\n', 'utf8');
  writeFileSync(join(simejiProfile, 'setup.md'), '# Setup\n', 'utf8');
  writeFileSync(join(simejiProfile, 'test.md'), '# Test\n', 'utf8');
  writeFileSync(
    join(simejiProfile, 'capabilities.yaml'),
    [
      'schema: roma.repo-capabilities/v1',
      'runtime:',
      '  jdk: "17"',
      '  kotlin: "2.1.10"',
      'package_manager: gradle',
      'commands:',
      '  build:',
      '    run: "./gradlew :Simeji:assembleBananaDebug"',
      '    cwd: "LatinIME"',
      'relations:',
      '  - to: baidu/facemoji-ad/TreasureBowl',
      '    kind: consumer',
      '    contract: "mavenLocal AAR"',
      '    joint_regression: true',
    ].join('\n') + '\n',
    'utf8'
  );

  const imeLibProfile = join(root, 'repos', 'baidu', 'gensoft-ipcs-mobile', 'ime-android-lib');
  mkdirSync(imeLibProfile, { recursive: true });
  writeFileSync(join(imeLibProfile, 'overview.md'), '# IME Android Lib\n', 'utf8');
  writeFileSync(join(imeLibProfile, 'setup.md'), '# Setup\n', 'utf8');
  writeFileSync(join(imeLibProfile, 'test.md'), '# Test\n', 'utf8');
  writeFileSync(
    join(imeLibProfile, 'capabilities.yaml'),
    [
      'schema: roma.repo-capabilities/v1',
      'runtime:',
      '  jdk: "1.8"',
      'commands:',
      '  publish_local:',
      '    run: "./gradlew uploadArchives"',
    ].join('\n') + '\n',
    'utf8'
  );

  writeFileSync(
    join(root, 'repos', 'index.md'),
    [
      '# 仓库索引',
      '```yaml',
      'schema: roma.repo-relations/v1',
      'relations:',
      '  - from: app/gensoft/ipcs-mobile/simeji-global',
      '    to: baidu/gensoft-ipcs-mobile/ime-android-lib',
      '    kind: consumer',
      '    contract: "com.baidu.ime.sdk"',
      '    joint_regression: true',
      '  - from: app/gensoft/ipcs-mobile/simeji-global',
      '    to: baidu/facemoji-ad/TreasureBowl',
      '    kind: consumer',
      '    contract: "TreasureBowl AAR"',
      '    joint_regression: true',
      '```',
    ].join('\n') + '\n',
    'utf8'
  );

  writeFileSync(
    join(root, 'docs', 'architecture', 'system-topology.md'),
    [
      '### 2.1 客户端宿主域',
      '| 仓库 | 技术栈 | 架构定位 | 入口 |',
      '| --- | --- | --- | --- |',
      '| `app/gensoft/ipcs-mobile/simeji-global` | `Kotlin 2.1.10 / JDK 17` | Android 宿主 | LatinIME |',
      '| `baidu/baiduglobalpc/facemoji-ios` | `Swift / ObjC` | iOS 宿主 | Facemoji |',
      '### 2.2 客户端 SDK 域',
      '| 仓库 | 技术栈 | 架构定位 | 入口 |',
      '| --- | --- | --- | --- |',
      '| `baidu/gensoft-ipcs-mobile/ime-android-lib` | `Java / JDK 8` | 基础组件库 | sdk |',
      '| `baidu/facemoji-ad/TreasureBowl` | `Kotlin / JDK 11` | 商业化聚合 SDK | plutus |',
      '| `baidu/facemoji/facemojisdk` | `Android SDK` | 内容 SDK | sdk |',
      '| `baidu/gensoft-ipcs-mobile/ime` | `C++ / JNI` | 内核引擎 | engine |',
      '### 2.3 API 网关域',
      '| 仓库 | 技术栈 | 架构定位 | 入口 |',
      '| --- | --- | --- | --- |',
      '| `baidu/gensoft-ipcs-mobile/gdp-facemoji-appui` | `Go` | 主网关 | main.go |',
      '| `baidu/gensoft-ipcs-mobile/odp-facemoji-appui` | `PHP` | 传统网关 | index.php |',
      '| `baidu/gensoft-ipcs-mobile/gdp-appui-library` | `Go` | 公共库 | lib |',
      '### 2.4 AI 与基础服务域',
      '| 仓库 | 技术栈 | 架构定位 | 入口 |',
      '| --- | --- | --- | --- |',
      '| `baidu/gensoft-ipcs-mobile/facemoji-python-server` | `Python` | AIGC 服务 | app.py |',
      '| `baidu/gensoft-ipcs-mobile/gdp-push-center` | `Go` | 云控服务 | push |',
      '| `baidu/gensoft-ipcs-mobile/gdp-simeji-report` | `Go` | 埋点上报 | report |',
      '| `baidu/gensoft-ipcs-mobile/gdp-translator-pay` | `Go` | 翻译与支付 | pay |',
      '| `baidu/gensoft-ipcs-mobile/gdp-simeji-ipquery` | `Go` | IP 归属 | ip |',
      '| `baidu/gensoft-ipcs-mobile/gdp-aws-service` | `Go` | AWS 存储 | s3 |',
    ].join('\n') + '\n',
    'utf8'
  );

  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(extRoot, { recursive: true, force: true });
    },
  };
}

test('repoPathFromRemote extracts normalized repo paths from iCode SSH and console URLs', () => {
  assert.equal(
    repoPathFromRemote('ssh://git@icode.baidu.com:8235/app/gensoft/ipcs-mobile/simeji-global'),
    'app/gensoft/ipcs-mobile/simeji-global'
  );
  assert.equal(
    repoPathFromRemote('https://console.cloud.baidu-int.com/devops/icode/repos/baidu/facemoji-ad/TreasureBowl/tree/master'),
    'baidu/facemoji-ad/TreasureBowl'
  );
  assert.equal(repoPathFromRemote('# comment line'), null);
});

test('parseWorkspaceAtlas aggregates all 15 repos, mount symlinks, capabilities, and SDK gates', async t => {
  const fixture = createFixtureWorkspace();
  t.after(() => fixture.cleanup());

  const snapshot = await parseWorkspaceAtlas(fixture.root);

  assert.equal(snapshot.workspace.isRoma, true);
  assert.equal(snapshot.workspace.totalRepos, 15);
  assert.equal(snapshot.workspace.mountedRepos, 2);
  assert.equal(snapshot.workspace.skippedRepos, 13);

  // Verify 4 architectural columns distribution (2 hosts, 4 sdks, 3 gateways, 6 services)
  const byCol = type => snapshot.repos.filter(r => r.col === type).map(r => r.id);
  assert.deepEqual(byCol('hosts'), ['simeji-global', 'facemoji-ios']);
  assert.equal(byCol('sdks').length, 4);
  assert.equal(byCol('gateways').length, 3);
  assert.equal(byCol('services').length, 6);

  // Verify mounted simeji-global
  const simeji = snapshot.repos.find(r => r.id === 'simeji-global');
  assert.ok(simeji);
  assert.equal(simeji.mounted, true);
  assert.equal(simeji.mountKind, 'symlink');
  assert.equal(simeji.profileCount, 4);
  assert.equal(simeji.runtime.jdk, '17');
  assert.ok(simeji.commands.some(c => c.name === 'build' && c.run.includes('assembleBananaDebug')));
  assert.ok(simeji.docs.overview?.includes('Simeji'));

  // Verify mounted ime-android-lib
  const imeLib = snapshot.repos.find(r => r.id === 'ime-android-lib');
  assert.ok(imeLib);
  assert.equal(imeLib.mounted, true);
  assert.equal(imeLib.mountKind, 'symlink');
  assert.equal(imeLib.profileCount, 4);
  assert.ok(imeLib.commands.some(c => c.name === 'publish_local'));

  // Verify relations & edges
  assert.ok(snapshot.edges.length >= 10);
  const tbEdge = snapshot.edges.find(e => e.from === 'simeji-global' && e.to === 'TreasureBowl');
  assert.ok(tbEdge);
  assert.equal(tbEdge.jointRegression, true);
});

test('host plugin registers /api/workspace-atlas and workspace_atlas tool', async t => {
  const fixture = createFixtureWorkspace();
  t.after(() => fixture.cleanup());

  const routes = new Map();
  const tools = new Map();
  const provided = new Map();

  const mockCtx = {
    effect(fn) {
      fn();
    },
    provide(name, svc) {
      provided.set(name, svc);
    },
    get(name) {
      if (name === 'tools') {
        return {
          register(def) {
            tools.set(def.name, def);
            return () => tools.delete(def.name);
          },
        };
      }
      if (name === 'workspaceRegistry') {
        return {
          list() {
            return [{ id: 'ws-1', path: fixture.root, title: 'all-in-one' }];
          },
        };
      }
      return undefined;
    },
    connection: {
      fetch: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => routes.delete(spec.path);
        },
      },
    },
  };

  await applyHost(mockCtx, { workspacePath: fixture.root });

  assert.ok(routes.has('/api/workspace-atlas'));
  assert.ok(tools.has('workspace_atlas'));
  assert.ok(provided.has('workspaceAtlas'));

  const route = routes.get('/api/workspace-atlas');
  const getRes = await route.fetch(new Request('http://localhost/api/workspace-atlas', { method: 'GET' }));
  assert.equal(getRes.status, 200);
  const payload = await getRes.json();
  assert.equal(payload.workspace.totalRepos, 15);
  assert.equal(payload.workspace.workspaceId, 'ws-1');

  const toolResult = await tools.get('workspace_atlas').execute({ repoId: 'simeji-global' });
  assert.equal(toolResult.repo.id, 'simeji-global');
});

test('host starts in unlinked onboarding state by default and supports linkDirectory, linkRemote, and unlinkWorkspace', async t => {
  const fixture = createFixtureWorkspace();
  t.after(() => fixture.cleanup());

  const routes = new Map();
  const mockCtx = {
    effect(fn) {
      fn();
    },
    provide() {},
    get() {
      return undefined;
    },
    connection: {
      fetch: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => routes.delete(spec.path);
        },
      },
    },
  };

  await applyHost(mockCtx, {
    stateFile: null,
    pickDirectory: async () => ({ canceled: false, path: fixture.root }),
  });
  const route = routes.get('/api/workspace-atlas');

  // 1. Default unlinked state
  const initRes = await route.fetch(new Request('http://localhost/api/workspace-atlas', { method: 'GET' }));
  const initData = await initRes.json();
  assert.equal(initData.linked, false);
  assert.equal(initData.workspace, null);
  assert.equal(initData.repos.length, 0);

  // 1b. Native directory picker endpoint
  const pickRes = await route.fetch(
    new Request('http://localhost/api/workspace-atlas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pickDirectory' }),
    })
  );
  const pickData = await pickRes.json();
  assert.equal(pickData.canceled, false);
  assert.equal(pickData.path, fixture.root);

  // 2. Link remote URL
  const remoteRes = await route.fetch(
    new Request('http://localhost/api/workspace-atlas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'linkRemote',
        remoteUrl: 'ssh://git@icode.baidu.com:8235/app/gensoft/ipcs-mobile/simeji-global',
      }),
    })
  );
  const remoteData = await remoteRes.json();
  assert.equal(remoteData.linked, true);
  assert.equal(remoteData.repos.length, 1);
  assert.equal(remoteData.repos[0].id, 'simeji-global');

  // 3. Unlink back to empty state
  const unlinkRes = await route.fetch(
    new Request('http://localhost/api/workspace-atlas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unlinkWorkspace', workspacePath: '@custom' }),
    })
  );
  const unlinkData = await unlinkRes.json();
  assert.equal(unlinkData.linked, false);

  // 4. Link project directory
  const dirRes = await route.fetch(
    new Request('http://localhost/api/workspace-atlas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'linkDirectory', path: fixture.root }),
    })
  );
  const dirData = await dirRes.json();
  assert.equal(dirData.linked, true);
  assert.equal(dirData.workspace.totalRepos, 15);
});

test('client plugin loads cleanly via window.__ModuleLoader__ and registers sidebar + main slots', () => {
  let loadedModule = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loadedModule = spec;
      },
    },
  };

  const clientCode = readFileSync(resolve(PLUGIN_DIR, 'client.js'), 'utf8');
  const run = new Function(clientCode);
  run();

  assert.ok(loadedModule);
  assert.equal(loadedModule.id, '@local/dsh-workspace-atlas');

  const fakeReact = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    Fragment: 'Fragment',
  };
  const plugin = loadedModule.factory(id => {
    if (id === 'react') return fakeReact;
    throw new Error('Unexpected require: ' + id);
  });

  const registeredSlots = [];
  const mockClientCtx = {
    effect(fn) {
      fn();
    },
    locale: {
      register: () => () => {},
      bind: () => key => key,
      subscribe: () => () => {},
      getSnapshot: () => 'zh',
    },
    slots: {
      inject(slotName, cb) {
        cb();
        return () => {};
      },
      register(opts, comp) {
        registeredSlots.push({ opts, comp });
        return () => {};
      },
    },
  };

  plugin.apply(mockClientCtx);
  assert.equal(registeredSlots.length, 2);
  assert.equal(registeredSlots[0].opts.name, 'sidebar.panellist');
  assert.equal(registeredSlots[0].opts.id, 'workspace-atlas');
  assert.equal(registeredSlots[1].opts.name, 'main');
  assert.equal(registeredSlots[1].opts.key, 'workspace-atlas');
});
