import { scrubSensitiveText } from '../app/sentinel/scrubber.js';
import {
  CallerAuthority,
  CallerDenied,
  CONNECTOR_TOOLS,
  type CallerAgent,
  type Invocation,
} from './authority.js';

export interface ExternalConnectorHost {
  /**
   * 由宿主在模型上下文之外代持解析凭证（Out-of-Band Credential Proxy）。
   * 模型仅传递逻辑别名（如 'github' | 'feishu'），宿主注入 Authorization 头，Token 永不进入提示词或返回结果。
   */
  resolveCredential?(credentialRef: string): { readonly headerName: string; readonly headerValue: string } | undefined;
  fetchImpl?: typeof fetch;
}

export interface ExternalConnectorInvocation<A extends CallerAgent> extends Invocation<A> {
  readonly name: string;
}

const MAX_RESPONSE_CHARS = 16_384;
const DEFAULT_TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

/**
 * 校验外部请求 URL，阻断内网地址、环回地址与云元数据端点（SSRF 防护）。
 */
export function validateExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new CallerDenied('CONNECTOR_URL_INVALID', '无效的 URL 格式。');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CallerDenied('CONNECTOR_PROTOCOL_DENIED', '仅支持 http/https 协议。');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new CallerDenied('CONNECTOR_SSRF_BLOCKED', '安全网关拦截：禁止通过外部连接器访问本机或内网私有地址。');
  }
  return parsed;
}

export function resolveOutOfBandCredential(
  credentialRef: string,
  host?: ExternalConnectorHost,
): { readonly headerName: string; readonly headerValue: string } | undefined {
  const cleanRef = credentialRef.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(cleanRef)) {
    throw new CallerDenied('CREDENTIAL_REF_INVALID', '凭证别名格式无效。');
  }
  const fromHost = host?.resolveCredential?.(cleanRef);
  if (fromHost) return fromHost;

  const envKey = `DSH_CONNECTOR_TOKEN_${cleanRef.toUpperCase().replace(/-/g, '_')}`;
  const envToken = process.env[envKey]?.trim();
  if (envToken) {
    return { headerName: 'Authorization', headerValue: `Bearer ${envToken}` };
  }
  return undefined;
}

export function externalConnectorToolDefinitions<A extends CallerAgent>(
  authority: CallerAuthority<A>,
  host: ExternalConnectorHost = {},
) {
  return [
    {
      name: CONNECTOR_TOOLS[0],
      description: '通过安全网关与凭证保险库代持（Out-of-Band Credential Proxy）读取外部 API 或网页数据（如 GitHub Issue/PR、公开文档、团队看板接口），返回经 Sentinel 脱敏后的内容。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            minLength: 8,
            maxLength: 1024,
            description: '目标 https/http URL（禁止访问内网或本地地址）。',
          },
          credentialRef: {
            type: 'string',
            minLength: 1,
            maxLength: 40,
            description: '可选的宿主代持凭证别名（如 github、feishu、linear），由宿主在带外注入鉴权头，模型无需接触真实 Token。',
          },
          accept: {
            type: 'string',
            maxLength: 120,
            description: '可选 Accept 请求头（默认 application/json, text/plain, text/markdown）。',
          },
        },
        required: ['url'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: ExternalConnectorInvocation<A>) => {
        const lease = authority.capture(exec);
        lease.require(CONNECTOR_TOOLS[0], 'read');
        if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
          throw new CallerDenied('CONNECTOR_DENIED', '只有前台大肥鱼或定时会话可调用外部连接器。');
        }
        const input = asRecord(rawArgs);
        if (Object.keys(input).some(k => !['url', 'credentialRef', 'accept'].includes(k))) {
          throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
        }
        if (typeof input.url !== 'string') {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供有效的 url。');
        }
        const parsedUrl = validateExternalUrl(input.url);
        const headers: Record<string, string> = {
          Accept: typeof input.accept === 'string' && input.accept.trim()
            ? input.accept.trim()
            : 'application/json, text/markdown, text/plain;q=0.9',
          'User-Agent': 'DSH-SuperAgent-Connector/1.0',
        };
        let credentialInjected = false;
        if (input.credentialRef !== undefined) {
          if (typeof input.credentialRef !== 'string') {
            throw new CallerDenied('INVALID_ARGUMENTS', 'credentialRef 必须是字符串。');
          }
          const resolved = resolveOutOfBandCredential(input.credentialRef, host);
          if (!resolved) {
            return {
              status: 'credential_missing',
              credentialRef: input.credentialRef,
              message: `宿主未配置别名为 "${input.credentialRef}" 的代持凭证（可设置环境变量 DSH_CONNECTOR_TOKEN_${input.credentialRef.toUpperCase().replace(/-/g, '_')}）。`,
            };
          }
          headers[resolved.headerName] = resolved.headerValue;
          credentialInjected = true;
        }

        const fetchFn = host.fetchImpl ?? globalThis.fetch;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const onAbort = () => controller.abort();
        exec.signal.addEventListener('abort', onAbort, { once: true });

        try {
          const response = await fetchFn(parsedUrl.toString(), {
            method: 'GET',
            headers,
            signal: controller.signal,
            redirect: 'manual',
          });
          const rawBody = await response.text();
          const scrubbed = scrubSensitiveText(rawBody.slice(0, MAX_RESPONSE_CHARS));
          return {
            status: response.ok ? 'ok' : 'http_error',
            httpStatus: response.status,
            url: parsedUrl.origin + parsedUrl.pathname,
            credentialInjected,
            body: scrubbed.text,
            redactedCount: scrubbed.redactedCount,
            truncated: rawBody.length > MAX_RESPONSE_CHARS,
          };
        } finally {
          clearTimeout(timer);
          exec.signal.removeEventListener('abort', onAbort);
        }
      },
    },
  ];
}
