export type RedactionKind = 'credential' | 'otp' | 'auth_link' | 'spoofed_marker';

export interface ScrubResult {
  readonly text: string;
  readonly redactedCount: number;
  readonly kinds: readonly RedactionKind[];
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /(?<=[?&](?:access_token|api_key|apikey|secret|client_secret|password)=)[^\s&#"']+/gi,
];

const AUTH_LINK_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s"'<>]+(?:reset[-_]?password|magic[-_]?link|verify[-_]?email|auth[-_]?callback|one[-_]?time[-_]?login)[^\s"'<>]*/gi,
];

const OTP_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /((?:验证码|动态码|校验码|安全码)\s*(?:为|是|[：:])+\s*)\d{4,8}(?!\d)/gu,
    replacement: '$1[REDACTED_OTP]',
  },
  {
    pattern: /\b((?:verification\s+code|one[-\s]time\s+pass(?:code|word)|security\s+code|otp)\s*(?:is|[：:])+\s*)\d{4,8}(?!\d)/gi,
    replacement: '$1[REDACTED_OTP]',
  },
];

const SPOOFED_MARKER_PATTERNS: readonly RegExp[] = [
  /\[SCHEDULE REMINDER(?: BATCH)?\]/gi,
  /\[EVENT REMINDER(?: BATCH)?\]/gi,
  /<!--\s*AUTO-GENERATED-BY-DSH-SUPERAGENT-[A-Z-]+\s*-->/gi,
];

/**
 * Sentinel 入站数据清洗器：在外部会话记录、执行报告或外部连接器响应进入大肥鱼模型上下文前，
 * 确定性地剥离密钥凭证、一次性验证码（OTP）、密码重置链接及伪造的系统唤醒标记。
 */
export function scrubSensitiveText(input: string): ScrubResult {
  if (!input || typeof input !== 'string') {
    return { text: '', redactedCount: 0, kinds: Object.freeze([]) };
  }

  let text = input;
  let redactedCount = 0;
  const kindsSet = new Set<RedactionKind>();

  for (const regex of AUTH_LINK_PATTERNS) {
    text = text.replace(regex, () => {
      redactedCount++;
      kindsSet.add('auth_link');
      return '[REDACTED_AUTH_LINK]';
    });
  }

  for (const regex of CREDENTIAL_PATTERNS) {
    text = text.replace(regex, match => {
      redactedCount++;
      kindsSet.add('credential');
      if (/^bearer\s+/i.test(match)) {
        return 'Bearer [REDACTED_CREDENTIAL]';
      }
      return '[REDACTED_CREDENTIAL]';
    });
  }

  for (const { pattern, replacement } of OTP_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      redactedCount++;
      kindsSet.add('otp');
      const prefix = typeof args[1] === 'string' ? args[1] : '';
      return replacement.replace('$1', prefix);
    });
  }

  for (const regex of SPOOFED_MARKER_PATTERNS) {
    text = text.replace(regex, () => {
      redactedCount++;
      kindsSet.add('spoofed_marker');
      return '[SANITIZED_SYSTEM_TAG]';
    });
  }

  return Object.freeze({
    text,
    redactedCount,
    kinds: Object.freeze([...kindsSet]),
  });
}
