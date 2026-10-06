import { FIELD_ERRORS, FORM_ERRORS } from '../forms/messages.js';
import { UPLOAD_KINDS, type UploadKind } from '../forms/registry.js';
import type { FormNode } from '../forms/tree.js';

/**
 * Visitor-facing renderer text (Japanese). Field labels, help and messages
 * come from the definition; these are the renderer's own words around them.
 */
export const UI = {
  loading: 'フォームを読み込んでいます…',
  unavailable: 'このフォームは現在ご利用いただけません。',
  loadFailed: 'フォームを読み込めませんでした。通信状況をご確認のうえ、もう一度お試しください。',
  unsupported: 'このフォームは現在表示できません。お手数ですが、時間をおいて再度お試しください。',
  retry: '再読み込み',
  required: '必須',
  networkError: '通信に失敗したため、送信できませんでした。入力内容は保持されています。接続をご確認のうえ、もう一度お試しください。',
  unknownError: '送信できませんでした。入力内容は保持されています。しばらくしてから、もう一度お試しください。',
  errorSummary: '入力内容に誤りがあります。以下の項目をご確認ください。',
  retryAfter: (seconds: number) => `約${formatNumber(seconds)}秒後に、もう一度お試しください。`,
  verificationPending: '送信前の確認が完了していません。確認が終わるまでお待ちください。',
  verificationUnavailable: '送信前の確認を読み込めませんでした。ページを再読み込みしてから、もう一度お試しください。',
  verificationLabel: '送信前の確認',
  versionReloadFailed: 'フォームの更新内容を読み込めませんでした。ページを再読み込みしてください。',
  changedField: 'フォームの更新により変更された項目です。内容をご確認ください。',
  confirmHeading: '入力内容の確認',
  confirmIntro: '以下の内容で送信します。よろしければ送信してください。',
  back: '修正する',
  confirmSubmit: '送信する',
  sending: '送信中…',
  empty: '（未入力）',
  yes: 'はい',
  no: 'いいえ',
  agreed: '同意する',
  notAgreed: '同意しない',
  steps: ['入力', '確認', '完了'] as const,
  stepsLabel: '送信の手順',
  defaultSuccess: '送信が完了しました。',
  selectPrompt: '選択してください',
  policyLink: 'プライバシーポリシー（新しいタブで開きます）',
  fileRemove: '削除',
  fileRemoveLabel: (name: string) => `${name} を削除`,
  fileNone: 'ファイルは選択されていません。',
  fileLimits: (kinds: string, size: string, count: number) => `添付できる形式：${kinds}／1ファイル${size}まで／${count}ファイルまで`,
  rangeUnset: '未選択',
  charactersUsed: (n: number, max?: number) => (max === undefined ? `${formatNumber(n)}文字` : `${formatNumber(n)}／${formatNumber(max)}文字`),
  charactersRemaining: (left: number) => (left >= 0 ? `残り${formatNumber(left)}文字` : `${formatNumber(-left)}文字オーバー`),
  honeypotLabel: 'この欄は入力しないでください',
};

export function formatNumber(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** Default maximum lengths per type (contract §4), for `{max}` in messages. */
const DEFAULT_MAX_LENGTH: Record<string, number> = { text: 5000, hidden: 500, textarea: 20000, email: 254, tel: 30, url: 2000 };

/** The Japanese message for a field error code, with `{min}`/`{max}` filled and preset/format variants. */
export function fieldMessage(code: string, node: FormNode): string {
  const v = (node.validation ?? {}) as Record<string, unknown>;
  const variant = node.preset ?? v.format;
  const template = (variant !== undefined && FIELD_ERRORS[`${code}.${variant}`]) || FIELD_ERRORS[code] || FIELD_ERRORS.invalid_type!;
  let min: unknown;
  let max: unknown;
  switch (code) {
    case 'too_short':
    case 'too_long':
      min = v.minLength;
      max = v.maxLength ?? DEFAULT_MAX_LENGTH[node.type];
      break;
    case 'too_few':
    case 'too_many':
      min = v.minSelected;
      max = v.maxSelected;
      break;
    case 'too_many_files':
      max = v.maxFiles ?? 1;
      break;
    default:
      min = v.min;
      max = v.max;
  }
  const show = (value: unknown) => (typeof value === 'number' ? formatNumber(value) : String(value ?? ''));
  return template.replaceAll('{min}', show(min)).replaceAll('{max}', show(max));
}

export function formMessage(code: string): string {
  return FORM_ERRORS[code] ?? FIELD_ERRORS.invalid_type!;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10)}MB`;
  if (bytes >= 1024) return `${formatNumber(Math.round(bytes / 1024))}KB`;
  return `${formatNumber(bytes)}B`;
}

const KIND_LABELS: Record<UploadKind, string> = { pdf: 'PDF', jpeg: 'JPEG', png: 'PNG', webp: 'WebP', text: 'テキスト' };

export function kindLabels(kinds: readonly UploadKind[]): string {
  return kinds.map((k) => KIND_LABELS[k]).join('・');
}

/** The `accept` attribute for a file input: extensions and MIME types of each allowed kind. */
export function acceptAttribute(kinds: readonly UploadKind[]): string {
  return kinds.flatMap((k) => [...UPLOAD_KINDS[k].extensions.map((e) => `.${e}`), ...UPLOAD_KINDS[k].mime]).join(',');
}

/** How an answer reads back to the visitor (confirmation step, reflections). */
export function displayValue(node: FormNode, value: unknown): string {
  const options = (node.options ?? []) as { value: string; label: string }[];
  const label = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  switch (node.type) {
    case 'select':
    case 'radio':
      return typeof value === 'string' && value !== '' ? label(value) : '';
    case 'multiselect':
    case 'checkboxes':
      return Array.isArray(value) ? value.map((v) => label(String(v))).join('、') : '';
    case 'checkbox':
      return value === true ? UI.yes : UI.no;
    case 'acceptance':
      return value === true ? UI.agreed : UI.notAgreed;
    case 'file':
      return Array.isArray(value) ? value.map((f) => (typeof f === 'string' ? f : (f as File).name)).join('、') : '';
    case 'datetime':
      return typeof value === 'string' ? value.replace('T', ' ') : '';
    default:
      return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  }
}
