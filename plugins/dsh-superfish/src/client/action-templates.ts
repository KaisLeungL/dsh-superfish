import { BOARD, SCHEDULE, type ActionId } from '../actions/protocol.js';

export const week = ['周一','周二','周三','周四','周五','周六','周日'];
const recurrence = [{ value:'daily', label:'每天' }, { value:'weekly', label:'每周' }];
const columns = [{ value:'todo', label:'待办' }, { value:'backlog', label:'待规划' }];
const permissions = [
  { value: '', label: '默认（跟随看板配置）' },
  { value: 'read-only', label: '只读分析 (read-only)' },
  { value: 'workspace-write', label: '工作区读写 (workspace-write)' },
];
type Field = {
  key: 'title' | 'instruction' | 'description' | 'prompt' | 'projectId' | 'column' | 'targetDate' | 'permission' | 'mode' | 'kind' | 'time' | 'timeZone' | 'weekdays';
  label: string;
  control: 'text' | 'textarea' | 'select' | 'time' | 'date' | 'weekdays';
  wide?: boolean;
  maxLength?: number;
  placeholder?: string;
  options?: readonly { value:string; label:string }[];
};
export const templates: Record<ActionId, { kind:string; area:string; fields:readonly Field[] }> = {
  [SCHEDULE]: {
    kind:'定时任务', area:'定时任务',
    fields:[
      { key:'title', label:'任务名称', control:'text', wide:true, maxLength:120 },
      { key:'instruction', label:'执行内容', control:'textarea', wide:true, maxLength:4000 },
      { key:'kind', label:'运行频率', control:'select', options:recurrence },
      { key:'time', label:'运行时间', control:'time' },
      { key:'weekdays', label:'运行日期', control:'weekdays', wide:true },
      { key:'timeZone', label:'时区', control:'text', maxLength:96 },
    ],
  },
  [BOARD]: {
    kind:'任务卡片', area:'任务看板',
    fields:[
      { key:'projectId', label:'所属项目', control:'select' },
      { key:'column', label:'所在列', control:'select', options:columns },
      { key:'permission', label:'执行权限', control:'select', options:permissions },
      { key:'mode', label:'执行模式', control:'text', maxLength:128, placeholder:'默认（如 claude-code / codex）' },
      { key:'targetDate', label:'执行时间', control:'date', wide:true },
      { key:'title', label:'卡片标题', control:'text', wide:true, maxLength:120, placeholder:'请输入任务标题（必填）' },
      { key:'prompt', label:'执行提示词 (Prompt)', control:'textarea', wide:true, maxLength:20000, placeholder:'输入简单需求后点击右上角「AI 解析」生成具体 Prompt，或直接编写执行指令' },
      { key:'description', label:'任务描述', control:'textarea', wide:true, maxLength:4000, placeholder:'补充任务背景或备注说明（可选）' },
    ],
  },
};
