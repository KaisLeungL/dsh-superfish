export interface PersonalSnapshotEvent<T = unknown> {
  readonly sessionId: string;
  readonly snapshot: T;
}

type SnapshotListener = (event: PersonalSnapshotEvent) => void;
type RefreshListener = (sessionId: string) => void;
type RunningListener = (sessionId: string, running: boolean) => void;

const snapshotListeners = new Set<SnapshotListener>();
const refreshListeners = new Set<RefreshListener>();
const runningListeners = new Set<RunningListener>();
const runningSessions = new Map<string, boolean>();
const cachedSnapshots = new Map<string, unknown>();

export function getCachedPersonalSnapshot<T>(sessionId: string): T | undefined {
  if (!sessionId) return undefined;
  return cachedSnapshots.get(sessionId) as T | undefined;
}

export function clearCachedPersonalSnapshot(sessionId?: string): void {
  if (!sessionId) {
    cachedSnapshots.clear();
    return;
  }
  cachedSnapshots.delete(sessionId);
}

export function publishPersonalSnapshot<T>(sessionId: string, snapshot: T): void {
  if (!sessionId) return;
  cachedSnapshots.set(sessionId, snapshot);
  const event: PersonalSnapshotEvent<T> = { sessionId, snapshot };
  for (const listener of [...snapshotListeners]) {
    try { listener(event); } catch { /* 忽略单个订阅方异常 */ }
  }
}

export function subscribePersonalSnapshot<T>(listener: (event: PersonalSnapshotEvent<T>) => void): () => void {
  const wrapped = listener as SnapshotListener;
  snapshotListeners.add(wrapped);
  return () => { snapshotListeners.delete(wrapped); };
}

export function requestPersonalRefresh(sessionId: string): void {
  if (!sessionId) return;
  for (const listener of [...refreshListeners]) {
    try { listener(sessionId); } catch { /* 忽略单个订阅方异常 */ }
  }
}

export function subscribePersonalRefresh(listener: RefreshListener): () => void {
  refreshListeners.add(listener);
  return () => { refreshListeners.delete(listener); };
}

export function setPersonalSessionRunning(sessionId: string, running: boolean): void {
  if (!sessionId) return;
  const prev = runningSessions.get(sessionId) ?? false;
  if (prev === running) return;
  runningSessions.set(sessionId, running);
  for (const listener of [...runningListeners]) {
    try { listener(sessionId, running); } catch { /* 忽略单个订阅方异常 */ }
  }
}

export function isPersonalSessionRunning(sessionId: string): boolean {
  return Boolean(sessionId && runningSessions.get(sessionId));
}

export function subscribePersonalSessionRunning(listener: RunningListener): () => void {
  runningListeners.add(listener);
  return () => { runningListeners.delete(listener); };
}
