import { API_ERRORS, type ApiErrorCode } from '../forms/messages.js';
import type { PublicDefinition } from '../forms/public.js';
import { h } from './dom.js';
import type { PreviewHooks, PreviewMountConfig } from './types.js';

/**
 * Local preview for `<YatrisForm>` (`@yatris/astro/forms/preview`), for
 * `astro dev` with YATRIS_FORMS_PREVIEW=1 only. It answers the renderer's
 * requests itself with synthetic responses, so nothing leaves the browser:
 * no submission, no mail. Production builds resolve the preview import to
 * null, so this module never reaches `dist/`.
 */

export const PREVIEW_MODULE_ID = 'yatris-forms-preview-module';

export const PREVIEW_SCENARIOS = [
  { id: 'accepted', label: '送信成功（宣言どおりの完了表示・移動）' },
  { id: 'validation_failed', label: 'サーバー検証エラー（validation_failed）' },
  { id: 'verification_failed', label: '送信前確認の失敗（verification_failed）' },
  { id: 'form_version_changed', label: 'フォーム更新（form_version_changed）' },
  { id: 'idempotency_conflict', label: '重複送信の競合（idempotency_conflict）' },
  { id: 'payload_too_large', label: 'サイズ超過（payload_too_large）' },
  { id: 'rate_limited', label: '送信制限（rate_limited・30秒）' },
  { id: 'temporarily_unavailable', label: '一時的に利用不可（temporarily_unavailable）' },
  { id: 'form_unavailable', label: 'フォーム停止中（form_unavailable）' },
  { id: 'network', label: '通信エラー（応答なし）' },
] as const;

export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number]['id'];

export interface PreviewController extends PreviewHooks {
  scenario: PreviewScenario;
  /** What the renderer would have sent, newest last. */
  readonly requests: Record<string, string | string[]>[];
}

export function createPreview(config: PreviewMountConfig): PreviewController {
  // A mount whose declaration is missing or invalid shows its problem and never fetches.
  const base = config.definition as PublicDefinition;
  let version = base?.form.version ?? 1;
  let log: HTMLElement | null = null;
  const requests: Record<string, string | string[]>[] = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const reject = (code: ApiErrorCode, extra: Record<string, unknown> = {}) =>
    json(API_ERRORS[code].status[0]!, { status: 'rejected', code, message: API_ERRORS[code].message, ...extra }, code === 'rate_limited' ? { 'retry-after': '30' } : {});

  const controller: PreviewController = {
    scenario: 'accepted',
    requests,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json(200, { ...base, form: { ...base.form, version } });

      const sent: Record<string, string | string[]> = {};
      for (const [name, value] of (init.body as FormData).entries()) {
        const text = typeof value === 'string' ? value : `${value.name} (${value.size} bytes, ${value.type || 'unknown type'})`;
        const prior = sent[name];
        sent[name] = prior === undefined ? text : [...(Array.isArray(prior) ? prior : [prior]), text];
      }
      requests.push(sent);
      if (log) log.textContent = JSON.stringify(sent, null, 2);
      console.info('[yatris forms preview] not sent:', sent);

      switch (controller.scenario) {
        case 'accepted': {
          const success = base.success as { mode?: string; redirectPath?: string; message?: string };
          return json(202, {
            status: 'accepted',
            receipt: 'preview',
            success: success.mode === 'redirect' ? { mode: 'redirect', path: success.redirectPath } : { mode: 'message', message: success.message },
          });
        }
        case 'validation_failed': {
          let answers: Record<string, unknown> = {};
          try {
            answers = JSON.parse(String(sent.answers ?? '{}'));
          } catch {
            // keep empty
          }
          const key = Object.keys(answers).find((k) => typeof answers[k] === 'string');
          return reject('validation_failed', key ? { fieldErrors: { [key]: 'invalid_format' }, formErrors: [] } : { fieldErrors: {}, formErrors: ['payload_too_large_total'] });
        }
        case 'form_version_changed':
          version += 1;
          return reject('form_version_changed');
        case 'network':
          throw new TypeError('preview: simulated network failure');
        default:
          return reject(controller.scenario);
      }
    }) as typeof fetch,
    decorate(root: HTMLElement) {
      const select = h('select', { class: 'yf-preview-scenario', 'aria-label': '送信時の応答' }, ...PREVIEW_SCENARIOS.map((s) => h('option', { value: s.id }, s.label)));
      select.addEventListener('change', () => {
        controller.scenario = select.value as PreviewScenario;
      });
      log = h('pre', { class: 'yf-preview-log' }, 'まだ送信されていません。');
      root.prepend(
        h(
          'div',
          { class: 'yf-preview-marker', role: 'note', 'data-yf-preview-module': PREVIEW_MODULE_ID },
          h('p', { class: 'yf-preview-title' }, `プレビュー表示：${config.source} を表示しています。送信・メール送信は行われません。`),
          h('label', { class: 'yf-preview-control' }, '送信時の応答：', select),
          h('details', { class: 'yf-preview-details' }, h('summary', {}, '最後の送信内容（送信されていません）'), log),
        ),
      );
    },
  };
  return controller;
}

export default { createPreview };
