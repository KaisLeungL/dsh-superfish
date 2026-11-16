import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WSA_HISTORY_PAGE_OPTIONS,
  WSA_HISTORY_PAGE_SIZE,
  attachChatTransport,
  computeHistoryPagination,
  countMessagesFromTurn,
  withRemoteHistoryPagination,
  type ChatModelDirectories,
  type ChatReference,
  type HistoryChatNodeLike,
} from '../../src/client/chat-transport.js';

function createTurnNodes(turnCount: number, messagesPerTurn = 2, includeProcessAndTail = true) {
  const order: string[] = [];
  const map = new Map<string, HistoryChatNodeLike>();
  for (let t = 0; t < turnCount; t++) {
    const userKey = `turn-${t}-user`;
    order.push(userKey);
    map.set(userKey, {
      kind: 'user',
      location: { kind: 'turn', turn: { turn: t } },
    });

    if (includeProcessAndTail) {
      const processKey = `turn-${t}-process`;
      order.push(processKey);
      map.set(processKey, {
        kind: 'turn-process',
        location: { kind: 'turn', turn: { turn: t } },
      });

      const toolKey = `turn-${t}-tool`;
      order.push(toolKey);
      map.set(toolKey, {
        kind: 'tool-call',
        location: { kind: 'step', turn: { turn: t } },
      });
    }

    for (let m = 1; m < messagesPerTurn; m++) {
      const assistantKey = `turn-${t}-assistant-${m}`;
      order.push(assistantKey);
      map.set(assistantKey, {
        kind: 'assistant-step',
        location: { kind: 'step', turn: { turn: t } },
      });
    }

    if (includeProcessAndTail) {
      const tailKey = `turn-${t}-tail`;
      order.push(tailKey);
      map.set(tailKey, {
        kind: 'turn-tail',
        location: { kind: 'turn', turn: { turn: t } },
      });
    }
  }
  return {
    order,
    nodes: {
      get: (key: string) => map.get(key),
    },
    map,
  };
}

test('历史消息分页常量默认每页加载 30 条消息', () => {
  assert.equal(WSA_HISTORY_PAGE_SIZE, 30);
  assert.deepEqual(WSA_HISTORY_PAGE_OPTIONS, {
    maxMessages: 30,
    turnWindow: {
      minMessages: 30,
      minTurns: 1,
    },
  });
});

test('computeHistoryPagination：少于或等于 30 条消息时全部展示，不隐藏任何轮次', () => {
  const { order, nodes } = createTurnNodes(12, 2); // 24 messages
  const page = computeHistoryPagination(order, nodes, WSA_HISTORY_PAGE_SIZE);
  assert.equal(page.totalMessages, 24);
  assert.equal(page.visibleMessages, 24);
  assert.equal(page.hiddenMessageCount, 0);
  assert.deepEqual(page.hiddenTurnNumbers, []);
  assert.equal(page.firstVisibleTurn, 0);
  assert.equal(page.latestTurn, 11);
});

test('computeHistoryPagination：超过 30 条消息时初始仅展示最近 30 条，点击加载更多每次递增 30 条', () => {
  const { order, nodes } = createTurnNodes(45, 2); // 45 turns = 90 messages (user + assistant)
  const initial = computeHistoryPagination(order, nodes, WSA_HISTORY_PAGE_SIZE);
  assert.equal(initial.totalMessages, 90);
  assert.equal(initial.visibleMessages, 30);
  assert.equal(initial.hiddenMessageCount, 60);
  assert.equal(initial.visibleTurns, 15);
  assert.equal(initial.firstVisibleTurn, 30);
  assert.equal(initial.latestTurn, 44);
  assert.equal(initial.hiddenTurnNumbers.length, 30);
  assert.equal(initial.hiddenTurnNumbers[0], 0);
  assert.equal(initial.hiddenTurnNumbers.at(-1), 29);

  // 点击一次「加载更多历史消息」（30 -> 60）
  const secondPage = computeHistoryPagination(order, nodes, WSA_HISTORY_PAGE_SIZE * 2);
  assert.equal(secondPage.visibleMessages, 60);
  assert.equal(secondPage.hiddenMessageCount, 30);
  assert.equal(secondPage.visibleTurns, 30);
  assert.equal(secondPage.firstVisibleTurn, 15);
  assert.equal(secondPage.hiddenTurnNumbers.length, 15);
  assert.equal(secondPage.hiddenTurnNumbers[0], 0);
  assert.equal(secondPage.hiddenTurnNumbers.at(-1), 14);

  // 再点击一次「加载更多历史消息」（60 -> 90）
  const thirdPage = computeHistoryPagination(order, nodes, WSA_HISTORY_PAGE_SIZE * 3);
  assert.equal(thirdPage.visibleMessages, 90);
  assert.equal(thirdPage.hiddenMessageCount, 0);
  assert.equal(thirdPage.visibleTurns, 45);
  assert.equal(thirdPage.firstVisibleTurn, 0);
  assert.deepEqual(thirdPage.hiddenTurnNumbers, []);
});

test('countMessagesFromTurn：底部新增实时对话消息时保持锚定轮次，顶部预加载更早轮次不影响锚定计数', () => {
  const { order, nodes, map } = createTurnNodes(25, 2); // 50 messages (turns 0..24)
  const initial = computeHistoryPagination(order, nodes, WSA_HISTORY_PAGE_SIZE);
  assert.equal(initial.firstVisibleTurn, 10); // turns 10..24 = 15 turns = 30 messages
  assert.equal(countMessagesFromTurn(order, nodes, 10), 30);

  // 模拟底部新增第 25 轮（2 条新消息）
  order.push('turn-25-user', 'turn-25-assistant-1');
  map.set('turn-25-user', { kind: 'user', location: { kind: 'turn', turn: { turn: 25 } } });
  map.set('turn-25-assistant-1', { kind: 'assistant-step', location: { kind: 'step', turn: { turn: 25 } } });

  const nextLimit = countMessagesFromTurn(order, nodes, 10);
  assert.equal(nextLimit, 32);
  const afterTailAppend = computeHistoryPagination(order, nodes, nextLimit);
  assert.equal(afterTailAppend.firstVisibleTurn, 10);
  assert.equal(afterTailAppend.visibleMessages, 32);
  assert.equal(afterTailAppend.hiddenMessageCount, 20);
});

test('attachChatTransport 与 withRemoteHistoryPagination：将 follow 与 page 请求限制为 30 条消息并在释放时还原', async () => {
  const seenFollow: Record<string, unknown>[] = [];
  const seenPage: Record<string, unknown>[] = [];
  const baseSessionApi = {
    prompt: async () => ({ ok: true as const, value: { accepted: true as const } }),
    follow: async function* (request: Record<string, unknown>) {
      seenFollow.push(request);
      yield { type: 'snapshot', records: [], hasMore: true };
    },
    page: async (request: Record<string, unknown>) => {
      seenPage.push(request);
      return { ok: true, value: { records: [], hasMore: false } };
    },
  };
  const originalRemote = { session: baseSessionApi };
  const eventsObj: { remote: unknown } = { remote: originalRemote };
  const reference: ChatReference = {
    sessionId: 'steward-session',
    binding: {
      session: {
        remote: originalRemote,
        events: eventsObj,
      },
    },
    ready: Promise.resolve(),
    release() {},
  };
  const models: ChatModelDirectories = {
    directoryFor: () => ({
      sessions: {
        selectModel: async ({ provider, model }) => ({ ok: true, value: { selected: { provider, model } } }),
      },
    }),
  };

  // 验证预包装的 remote.session.follow 会覆写 500 条默认值为 30 条
  const preWrapped = withRemoteHistoryPagination(originalRemote, 'steward-session');
  for await (const _frame of preWrapped.session.follow({
    address: { kind: 'session', sessionId: 'steward-session' },
    maxMessages: 500,
    turnWindow: { minMessages: 50, minTurns: 2 },
  })) {
    // consume
  }
  assert.equal(seenFollow.length, 1);
  assert.equal(seenFollow[0]?.maxMessages, 30);
  assert.deepEqual(seenFollow[0]?.turnWindow, { minMessages: 30, minTurns: 1 });

  // 其他普通会话不受影响
  for await (const _frame of preWrapped.session.follow({
    address: { kind: 'session', sessionId: 'other-session' },
    maxMessages: 500,
    turnWindow: { minMessages: 50, minTurns: 2 },
  })) {
    // consume
  }
  assert.equal(seenFollow.length, 2);
  assert.equal(seenFollow[1]?.maxMessages, 500);

  // 验证 attachChatTransport 同时替换 session.remote 和 session.events.remote 的分页参数
  const detach = attachChatTransport(reference, models, async () => ({ ok: true }));
  assert.notEqual(reference.binding.session.remote, originalRemote);
  assert.equal(eventsObj.remote, reference.binding.session.remote);

  await (eventsObj.remote as typeof originalRemote).session.page({
    address: { kind: 'session', sessionId: 'steward-session' },
    throughSeq: 120,
    maxMessages: 500,
    turnWindow: { minMessages: 50, minTurns: 2 },
  });
  assert.equal(seenPage.length, 1);
  assert.equal(seenPage[0]?.throughSeq, 120);
  assert.equal(seenPage[0]?.maxMessages, 30);
  assert.deepEqual(seenPage[0]?.turnWindow, { minMessages: 30, minTurns: 1 });

  detach();
  assert.equal(reference.binding.session.remote, originalRemote);
  assert.equal(eventsObj.remote, originalRemote);
});
