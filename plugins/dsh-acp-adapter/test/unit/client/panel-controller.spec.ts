import { describe, expect, it, vi } from 'vitest'
import { AcpPanelController } from '../../../src/client/data/controller.ts'
import { createAcpPanelStore } from '../../../src/client/data/stores/panel-store.ts'
import type { AcpProviderHealth } from '../../../src/client/data/logic.ts'
import type { AcpHealthView } from '../../../src/contract/remote.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function row(id: string, version: string): AcpProviderHealth {
  return {
    id,
    name: id,
    command: id,
    args: [],
    loginHint: null,
    executable: true,
    version,
    state: 'saved-unverified',
    probe: { status: 'never', at: null },
  }
}

function view(rows: readonly AcpProviderHealth[]): AcpHealthView {
  return { providers: rows, liveSessions: null }
}

describe('AcpPanelController targeted health checks', () => {
  it('allows different agents concurrently, deduplicates the same agent, and merges only its row', async () => {
    const devin = deferred<{ ok: true; value: AcpHealthView }>()
    const kimi = deferred<{ ok: true; value: AcpHealthView }>()
    const health = vi.fn((request?: { recheck?: boolean; agentId?: string }) => {
      if (request?.agentId === 'devin') return devin.promise
      if (request?.agentId === 'kimi') return kimi.promise
      return Promise.resolve({ ok: true as const, value: view([row('devin', 'old'), row('kimi', 'old')]) })
    })
    const scope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        revision: 1,
        value: {
          agents: {
            devin: { name: 'Devin', command: 'devin', args: ['acp'], env: {} },
            kimi: { name: 'Kimi', command: 'kimi', args: ['acp'], env: {} },
          },
        },
      }),
      subscribe: () => () => {},
    }
    const controller = new AcpPanelController({
      scope,
      mutate: vi.fn(),
      refusedMessage: () => 'refused',
      remote: {
        health,
        backendOf: vi.fn(),
        boundSessions: vi.fn(),
        activityFollow: async function* () {},
      } as never,
    })
    const store = createAcpPanelStore().create()
    controller.attach(store.actions)

    const initial = controller.refreshHealth()
    await initial
    const first = controller.refreshAgentHealth('devin')
    const duplicate = controller.refreshAgentHealth('devin')
    const second = controller.refreshAgentHealth('kimi')
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['devin', 'kimi'])
    expect(health).toHaveBeenCalledTimes(3)

    kimi.resolve({ ok: true, value: view([row('devin', 'stale-from-kimi'), row('kimi', 'new-kimi')]) })
    await second
    expect(store.getSnapshot().health.checkingAgentIds).toEqual(['devin'])
    devin.resolve({ ok: true, value: view([row('devin', 'new-devin'), row('kimi', 'stale-from-devin')]) })
    await Promise.all([first, duplicate])

    expect(store.getSnapshot().health.checkingAgentIds).toEqual([])
    expect(store.getSnapshot().health.rows.map((entry) => [entry.id, entry.version])).toEqual([
      ['devin', 'new-devin'],
      ['kimi', 'new-kimi'],
    ])
    expect(health).toHaveBeenNthCalledWith(2, { recheck: true, agentId: 'devin' })
    expect(health).toHaveBeenNthCalledWith(3, { recheck: true, agentId: 'kimi' })
    controller.dispose()
  })

  it('keeps a targeted failure on that card without making the whole panel unreachable', async () => {
    const scope = {
      getSnapshot: () => ({ status: 'ready' as const, writable: true, revision: 1, value: { agents: {} } }),
      subscribe: () => () => {},
    }
    const controller = new AcpPanelController({
      scope,
      mutate: vi.fn(),
      refusedMessage: () => 'refused',
      remote: {
        health: vi.fn((request?: { agentId?: string }) =>
          request?.agentId === 'devin'
            ? Promise.resolve({ ok: false as const, error: { message: 'devin probe failed' } })
            : Promise.resolve({ ok: true as const, value: view([]) }),
        ),
        backendOf: vi.fn(),
        boundSessions: vi.fn(),
        activityFollow: async function* () {},
      } as never,
    })
    const store = createAcpPanelStore().create()
    controller.attach(store.actions)
    await controller.refreshHealth()
    await controller.refreshAgentHealth('devin')
    expect(store.getSnapshot().health.status).toBe('ready')
    expect(store.getSnapshot().health.agentErrors).toEqual({ devin: 'devin probe failed' })
    controller.dispose()
  })

  it('drops the old directory and ignores a late check after the launch configuration changes', async () => {
    const pending = deferred<{ ok: true; value: AcpHealthView }>()
    const verified = {
      ...row('codex', 'old'),
      modelCatalog: { at: 1, models: [{ id: 'old-model', name: 'Old Model' }] },
    }
    let snapshot = {
      status: 'ready' as const,
      writable: true,
      revision: 1,
      value: { agents: { codex: { name: 'Codex', command: 'codex-acp', args: [], env: { CODEX_HOME: '/first' } } } },
    }
    let mirror = () => {}
    const controller = new AcpPanelController({
      scope: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          mirror = listener
          return () => {}
        },
      },
      mutate: vi.fn(),
      refusedMessage: () => 'refused',
      remote: {
        health: vi.fn((request?: { agentId?: string }) =>
          request?.agentId === 'codex' ? pending.promise : Promise.resolve({ ok: true, value: view([verified]) }),
        ),
      } as never,
    })
    const store = createAcpPanelStore().create()
    controller.attach(store.actions)
    await controller.refreshHealth()
    expect(store.getSnapshot().health.rows[0]?.modelCatalog).toEqual(verified.modelCatalog)
    const checking = controller.refreshAgentHealth('codex')
    snapshot = {
      ...snapshot,
      revision: 2,
      value: { agents: { codex: { ...snapshot.value.agents.codex, env: { CODEX_HOME: '/second' } } } },
    }
    mirror()
    expect(store.getSnapshot().health.rows).toEqual([])
    pending.resolve({ ok: true, value: view([verified]) })
    await checking
    expect(store.getSnapshot().health.rows).toEqual([])
    expect(store.getSnapshot().health.checkingAgentIds).toEqual([])
    controller.dispose()
  })
})
