import type { Context } from '@deepseek-ai/cordis';

export interface ScheduleNavigationService {
  openTask(id: string): boolean;
}

const SCHEDULE_PANEL_ID = 'schedules';

let activePollTimer: ReturnType<typeof setInterval> | undefined;

function stopActivePoll(): void {
  if (activePollTimer !== undefined) {
    clearInterval(activePollTimer);
    activePollTimer = undefined;
  }
}

function focusRequestedTaskInDom(taskId: string): void {
  if (typeof document === 'undefined') return;
  stopActivePoll();

  const suffix = `-metadata-${taskId}`;
  const startedAt = Date.now();

  const step = (): boolean => {
    const page = document.querySelector('[data-testid="task-manager-page"]');
    if (!page) return false;

    const filterTabs = page.querySelectorAll<HTMLButtonElement>('button[aria-pressed]');
    const allTab = filterTabs.length > 0 ? filterTabs[filterTabs.length - 1] : undefined;
    if (allTab && allTab.getAttribute('aria-pressed') !== 'true') {
      allTab.click();
    }

    const buttons = Array.from(page.querySelectorAll<HTMLButtonElement>('button[aria-describedby]'));
    for (const button of buttons) {
      const describedBy = button.getAttribute('aria-describedby');
      if (describedBy && describedBy.endsWith(suffix)) {
        if (button.getAttribute('aria-expanded') !== 'true') {
          button.click();
        }
        return button.getAttribute('aria-expanded') === 'true';
      }
    }
    return false;
  };

  if (step()) return;

  activePollTimer = setInterval(() => {
    if (step() || Date.now() - startedAt > 4000) {
      stopActivePoll();
    }
  }, 40);
}

export function createScheduleNavigation(ctx: Context): ScheduleNavigationService {
  return {
    openTask(id: string): boolean {
      if (typeof id !== 'string' || !id.trim()) return false;
      const layout = ctx.get('layout') as { selectPanel?(panelId: string): void } | undefined;
      if (typeof layout?.selectPanel !== 'function') return false;
      layout.selectPanel(SCHEDULE_PANEL_ID);
      focusRequestedTaskInDom(id.trim());
      return true;
    },
  };
}

export function installScheduleNavigation(ctx: Context): void {
  const service = createScheduleNavigation(ctx);
  const runtime = ctx as unknown as {
    get?(name: string): unknown;
    provide?(name: string, value: unknown): void;
    reflect?: { provide?(name: string, value: unknown): () => void };
    effect?(fn: () => void | (() => void)): void;
  };
  if (typeof runtime.get === 'function' && runtime.get('scheduleNavigation')) {
    return;
  }
  if (typeof runtime.reflect?.provide === 'function' && typeof runtime.effect === 'function') {
    runtime.effect(() => runtime.reflect!.provide!('scheduleNavigation', service));
  } else if (typeof runtime.provide === 'function') {
    runtime.provide('scheduleNavigation', service);
  }
  if (typeof runtime.effect === 'function') {
    runtime.effect(() => () => stopActivePoll());
  }
}

export function openScheduleTask(ctx: Context, id: string): boolean {
  const nav = ctx.get('scheduleNavigation') as ScheduleNavigationService | undefined;
  if (nav && typeof nav.openTask === 'function') {
    return nav.openTask(id);
  }
  return createScheduleNavigation(ctx).openTask(id);
}
