import * as React from 'react';
import { DEFAULT_BOT_NAME, MAX_AVATAR_DATA_URL_LENGTH } from '../app/health/chat-input.js';

export interface BotProfileSnapshot {
  readonly botName: string;
  readonly avatarDataUrl?: string;
}

const STORAGE_KEY = 'workspace-superagent-bot-profile';
const MAX_UPLOAD_FILE_BYTES = Math.floor(MAX_AVATAR_DATA_URL_LENGTH * 0.72);

function loadInitialProfile(): BotProfileSnapshot {
  if (typeof window === 'undefined') return { botName: DEFAULT_BOT_NAME };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { botName: DEFAULT_BOT_NAME };
    const parsed = JSON.parse(raw) as { botName?: unknown; avatarDataUrl?: unknown } | null;
    const botName = typeof parsed?.botName === 'string' && parsed.botName.trim()
      ? parsed.botName.trim().slice(0, 32)
      : DEFAULT_BOT_NAME;
    const avatarDataUrl = typeof parsed?.avatarDataUrl === 'string' && parsed.avatarDataUrl.startsWith('data:image/')
      ? parsed.avatarDataUrl
      : undefined;
    return { botName, ...(avatarDataUrl ? { avatarDataUrl } : {}) };
  } catch {
    return { botName: DEFAULT_BOT_NAME };
  }
}

let currentProfile: BotProfileSnapshot = loadInitialProfile();
const listeners = new Set<() => void>();
let remoteAvatarUpdater: ((avatarDataUrl: string | null) => void) | null = null;

export function registerRemoteAvatarUpdater(fn: ((avatarDataUrl: string | null) => void) | null): void {
  remoteAvatarUpdater = fn;
}

export function triggerGlobalAvatarUpdate(avatarDataUrl: string | null): void {
  setBotProfile({ avatarDataUrl });
  remoteAvatarUpdater?.(avatarDataUrl);
}

export function getBotProfile(): BotProfileSnapshot {
  return currentProfile;
}

export function setBotProfile(patch: { botName?: string; avatarDataUrl?: string | null }): void {
  const nextName = patch.botName !== undefined
    ? (patch.botName.trim().slice(0, 32) || DEFAULT_BOT_NAME)
    : currentProfile.botName;
  const nextAvatar = patch.avatarDataUrl === null
    ? undefined
    : patch.avatarDataUrl !== undefined
      ? (patch.avatarDataUrl.trim() || undefined)
      : currentProfile.avatarDataUrl;
  if (currentProfile.botName === nextName && currentProfile.avatarDataUrl === nextAvatar) return;
  currentProfile = Object.freeze({
    botName: nextName,
    ...(nextAvatar ? { avatarDataUrl: nextAvatar } : {}),
  });
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentProfile));
    } catch {
      /* 忽略存储配额限制，保留内存状态。 */
    }
  }
  for (const listener of listeners) listener();
}

export function resetBotProfile(): void {
  currentProfile = Object.freeze({ botName: DEFAULT_BOT_NAME });
  if (typeof window !== 'undefined') {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
  for (const listener of listeners) listener();
}

export function subscribeBotProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBotProfile(): BotProfileSnapshot {
  return React.useSyncExternalStore(subscribeBotProfile, getBotProfile, getBotProfile);
}

export function readAvatarFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(?:png|jpeg|jpg|gif|webp|svg\+xml)$/i.test(file.type)) {
      reject(new Error('请选择 PNG、JPG、GIF、WebP 或 SVG 格式的图片或动图。'));
      return;
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      reject(new Error('头像图片或动图大小请控制在 1.4MB 以内。'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result.startsWith('data:image/') || result.length > MAX_AVATAR_DATA_URL_LENGTH) {
        reject(new Error('无法读取该图片文件。'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error('读取头像文件失败。'));
    reader.readAsDataURL(file);
  });
}

export const AVATAR_ANIMATION_STYLES = `
@keyframes wsa-fish-bob{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-2.8px) rotate(-1.8deg)}}
@keyframes wsa-fish-tail{0%,100%{transform:rotate(0deg)}50%{transform:rotate(8.5deg)}}
@keyframes wsa-fish-b1{0%{transform:translateY(3px) scale(.6);opacity:0}45%{opacity:.78}100%{transform:translateY(-12px) scale(1.05);opacity:0}}
@keyframes wsa-fish-b2{0%{transform:translateY(5px) scale(.5);opacity:0}50%{opacity:.68}100%{transform:translateY(-10px) scale(.95);opacity:0}}
.wsa-anim-fish-svg{display:block;overflow:visible;flex:none}
.wsa-anim-fish-body{animation:wsa-fish-bob 2.4s cubic-bezier(.45,0,.55,1) infinite;transform-origin:center}
.wsa-anim-fish-tail{animation:wsa-fish-tail 1.2s ease-in-out infinite;transform-origin:44px 24px}
.wsa-anim-fish-b1{animation:wsa-fish-b1 2.6s ease-out infinite}
.wsa-anim-fish-b2{animation:wsa-fish-b2 2.6s ease-out 1s infinite}
@media(prefers-reduced-motion:reduce){
  .wsa-anim-fish-body,.wsa-anim-fish-tail,.wsa-anim-fish-b1,.wsa-anim-fish-b2{animation:none!important}
}
`;

export const BotAvatar = React.forwardRef<Element, {
  src?: string | undefined;
  size?: number;
  className?: string;
}>(function BotAvatar({ src, size = 28, className }, ref): React.ReactElement {
  if (src) {
    return (
      <img
        ref={ref as React.Ref<HTMLImageElement>}
        className={className}
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{
          objectFit: 'cover',
          borderRadius: 'inherit',
          display: 'block',
        }}
      />
    );
  }
  return (
    <svg
      ref={ref as React.Ref<SVGSVGElement>}
      className={className ? `wsa-anim-fish-svg ${className}` : 'wsa-anim-fish-svg'}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="wsa-anim-fish-b1" cx="12" cy="20" r="2.4" fill="#60A5FA" />
      <circle className="wsa-anim-fish-b2" cx="20" cy="14" r="1.7" fill="#93C5FD" />
      <g className="wsa-anim-fish-body">
        <g className="wsa-anim-fish-tail">
          <path
            d="M57 12c-5 0-9.5 3.5-10.5 8.5-.5 2.5-.2 5 1 7 4.8-1 8.5-5 9.5-10.2.5-2.5-.8-3.8-2.8-3.5-2 .3-4.2 1.8-5.7 4-.5-2.5-1.2-7-3-7Z"
            fill="#2563EB"
          />
        </g>
        <path
          d="M57 12c-5 0-9.5 3.5-10.5 8.5-.5 2.5-.2 5 1 7-2.5 2.5-5.5 3-8.5 1-2.2-1.5-5-3.2-8-4 .8-1.8 1.5-4.2 1-5.5-.5-1.2-4.5.2-7.5 3.5C15 24 8 31.5 8 41c0 9.5 8 16 19.5 16 13.5 0 23.5-8 23.5-19.5 0-3.2-.8-6.2-2-8.8 4.8-1 8.5-5 9.5-10.2.5-2.5-.8-3.8-2.8-3.5-2 .3-4.2 1.8-5.7 4-.5-2.5-1.2-7-3-7Z"
          fill="#3B5BF6"
        />
        <path
          d="M8.5 39.5c3.5-2 9-1.5 14 1.5 3.8 2.2 6.8 5.2 9.5 6.8 3.2 1.8 4.5 4.2 3 6.2-2 2.2-5.5 3-8.5 3-10.5 0-18-6.5-18-16 0-.5 0-1 .5-1.5Z"
          fill="#FFFFFF"
        />
        <path
          d="M24 37.5c2.2 1 5.2 4.8 4.8 8.2-.4 3-3.5 3.5-5.8 1.2-2.2-2.2-2.5-6.5-1.2-8.5.5-.8 1.2-1.3 2.2-.9Z"
          fill="#3B5BF6"
        />
        <circle cx="19" cy="32.5" r="2.6" fill="#FFFFFF" />
        <path d="M11 35.5c1.2 1 3 1 4.2 0" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
});
