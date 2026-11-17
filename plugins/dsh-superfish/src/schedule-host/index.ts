import type { Context } from '@deepseek-ai/cordis';

export interface ScheduleHostService {
  new (ctx: Context, config?: Record<string, unknown>): unknown;
}

export declare const ScheduleService: ScheduleHostService;
export default ScheduleService;
