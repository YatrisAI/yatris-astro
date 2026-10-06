// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ERRORS } from '../forms/messages.js';
import { toPublicDefinition, type PublicDefinition } from '../forms/public.js';
import { DISPLAY_TYPES, INPUT_TYPES } from '../forms/registry.js';
import { flatten, type FormDeclaration } from '../forms/tree.js';
import { mountAll, mountForm, SUPPORTED_CAPABILITIES, type FormController, type MountConfig, type TurnstileApi } from './index.js';
import { createPreview } from './preview.js';

// happy-dom rewrites import.meta.url, so resolve from the repository root vitest runs in.
const example = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'contracts/forms/v1/examples', `${name}.json`), 'utf8')) as FormDeclaration;
const ORIGIN = 'https://app.yatris.jp';

async function definitionOf(declaration: FormDeclaration, extra: Partial<{ version: number; turnstile: { siteKey: string; action: string } | null }> = {}): Promise<PublicDefinition> {
  const publicKey = `42.${declaration.key}`;
  return toPublicDefinition(declaration, {
    publicKey,
    version: extra.version ?? 3,
    endpoint: `${ORIGIN}/api/v1/forms/${publicKey}/submissions`,
    turnstile: extra.turnstile ?? null,
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const accepted = () => json(202, { status: 'accepted', receipt: 'r-1', success: { mode: 'message', message: 'ありがとうございました。' } });
const rejected = (code: keyof typeof API_ERRORS, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(API_ERRORS[code].status[0]!, { status: 'rejected', code, message: 'server text', ...extra }, headers);

type Reply = Response | (() => Response) | Error;

/** A stand-in for Yatris: serves definitions and answers POSTs from a queue. */
function fakeYatris(definitions: PublicDefinition | PublicDefinition[] | (() => Response), replies: Reply[] = []) {
  const gets: RequestInit[] = [];
  const posts: FormData[] = [];
  const queue = Array.isArray(definitions) ? [...definitions] : null;
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      gets.push(init ?? {});
      if (typeof definitions === 'function') return definitions();
      const d = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (definitions as PublicDefinition);
      return json(200, d);
    }
    posts.push(init.body as FormData);
    const reply = replies.shift() ?? accepted();
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, gets, posts };
}

function liveConfig(form: string, extra: Partial<MountConfig> = {}): MountConfig {
  return { mode: 'live', form, publicKey: `42.${form}`, definitionUrl: `${ORIGIN}/api/v1/forms/42.${form}`, timeZone: 'Asia/Tokyo', ...extra } as MountConfig;
}

async function mount(definition: PublicDefinition | PublicDefinition[] | (() => Response), replies: Reply[] = [], extra: Partial<MountConfig> = {}, options: Record<string, unknown> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const first = Array.isArray(definition) ? definition[0]! : typeof definition === 'function' ? null : definition;
  const server = fakeYatris(definition, replies);
  const navigate = vi.fn();
  const controller = mountForm(root, liveConfig(first?.form.key ?? 'contact', extra), { fetch: server.fetch, navigate, random: () => 0, ...options });
  await controller.ready;
  return { root, controller, server, navigate };
}

const field = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`[data-yf-field="${key}"]`)!;
const control = <T extends HTMLElement = HTMLInputElement>(root: HTMLElement, key: string) => field(root, key).querySelector<T>('input, textarea, select')!;

function type(root: HTMLElement, key: string, value: string) {
  const el = control<HTMLInputElement>(root, key);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function blur(root: HTMLElement, key: string) {
  control(root, key).dispatchEvent(new Event('blur'));
}
function pick(root: HTMLElement, key: string, value: string, checked = true) {
  const el = field(root, key).querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  el.checked = checked;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function check(root: HTMLElement, key: string, checked = true) {
  const el = control<HTMLInputElement>(root, key);
  el.checked = checked;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function choose(root: HTMLElement, key: string, value: string) {
  const el = control<HTMLSelectElement>(root, key);
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function attach(root: HTMLElement, key: string, files: File[]) {
  const el = control<HTMLInputElement>(root, key);
  Object.defineProperty(el, 'files', { value: files, configurable: true });
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
async function submit(root: HTMLElement) {
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const notice = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.yf-form-error')].find((e) => !e.hidden)?.textContent ?? '';
const answersOf = (body: FormData) => JSON.parse(String(body.get('answers')));

/** A small form without a confirmation step, for the submission tests. */
const simple = (overrides: Partial<FormDeclaration> = {}): FormDeclaration => ({
  contractVersion: 1,
  key: 'contact',
  name: 'お問い合わせ',
  locale: 'ja',
  fields: [
    { key: 'name', type: 'text', label: 'お名前', required: true, validation: { maxLength: 10 } },
    { key: 'email', type: 'email', label: 'メールアドレス', required: true },
    { key: 'source', type: 'hidden', default: 'website' },
  ],
  submit: { label: '送信する', pendingLabel: '送信中…' },
  success: { mode: 'message', message: 'ありがとうございました。' },
  mail: { notification: { to: ['owner@example.jp'], subject: 'x', body: 'x' }, thankYou: { enabled: false } },
  ...overrides,
});

function fillSimple(root: HTMLElement) {
  type(root, 'name', '山田');
  type(root, 'email', 'taro@example.jp');
}

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('capabilities', () => {
  it('covers exactly the contract v1 registry, conditions, uploads, presets and the confirmation step', () => {
    const expected = [
      ...INPUT_TYPES.map((t) => `field:${t}`),
      ...DISPLAY_TYPES.map((t) => `display:${t}`),
      'conditions',
      'uploads',
      'preset:katakana',
      'preset:hiragana',
      'confirm_step',
    ];
    expect([...SUPPORTED_CAPABILITIES].sort()).toEqual(expected.sort());
  });
});

describe('rendering every node type (full-coverage.json)', () => {
  it('draws each node as labelled, semantic HTML', async () => {
    const definition = await definitionOf(example('full-coverage'));
    const { root } = await mount(definition);

    for (const { node } of flatten(definition.fields)) {
      if (node.type === 'hidden') {
        expect(field(root, node.key)).toBeNull();
        continue;
      }
      expect(field(root, node.key)?.getAttribute('data-yf-type'), node.key).toBe(node.type);
    }
    expect(root.getAttribute('data-yf-state')).toBe('ready');

    // Every visible control has a programmatic label.
    for (const el of root.querySelectorAll<HTMLInputElement>('.yf-form input:not([type=hidden]), .yf-form select, .yf-form textarea')) {
      if (el.closest('.yf-hp')) continue;
      const labelled = el.closest('label') ?? root.querySelector(`label[for="${el.id}"]`);
      expect(labelled, el.name).not.toBeNull();
    }

    expect(field(root, 'intro').tagName).toBe('H2');
    expect(field(root, 'intro_help').textContent).toBe('* は必須項目です。');
    expect(field(root, 'divider_1').tagName).toBe('HR');
    expect(field(root, 'business').tagName).toBe('FIELDSET');
    expect(field(root, 'business').querySelector('legend')!.textContent).toBe('法人情報');
    expect(field(root, 'customer_type').tagName).toBe('FIELDSET');
    expect(field(root, 'customer_type').querySelector('legend')!.textContent).toContain('お問い合わせ区分');
    expect(field(root, 'customer_type').querySelectorAll('input[type=radio]')).toHaveLength(2);
    expect(field(root, 'interests').querySelectorAll('input[type=checkbox]')).toHaveLength(3);

    const topic = control<HTMLSelectElement>(root, 'topic');
    expect(topic.options[0]!.value).toBe('');
    expect(topic.options[0]!.textContent).toBe('選択してください');
    expect(control<HTMLSelectElement>(root, 'channels').multiple).toBe(true);
    expect(control(root, 'email').type).toBe('email');
    expect(control(root, 'tel').type).toBe('tel');
    expect(control(root, 'website').type).toBe('url');
    expect(control(root, 'employees').type).toBe('number');
    expect(control(root, 'visit_date').type).toBe('date');
    expect(control(root, 'phone_time').getAttribute('step')).toBe('1800');
    expect(control(root, 'visit_at').type).toBe('datetime-local');
    expect(control(root, 'budget').type).toBe('range');
    expect(field(root, 'budget').querySelector('output')!.textContent).toBe('50');
    expect(control(root, 'message').getAttribute('rows')).toBe('6');
    expect(field(root, 'message').querySelector('.yf-counter')!.textContent).toBe('残り2,000文字');

    const file = control(root, 'attachments');
    expect(file.type).toBe('file');
    expect(file.multiple).toBe(true);
    expect(file.accept).toContain('.pdf');
    expect(file.accept).toContain('image/webp');
    expect(field(root, 'attachments').querySelector('.yf-file-limits')!.textContent).toBe('添付できる形式：PDF・JPEG・PNG・WebP／1ファイル5MBまで／3ファイルまで');

    const consent = field(root, 'consent');
    expect(consent.querySelector('.yf-consent')!.textContent).toBe('お問い合わせへの回答のために入力内容を利用します。');
    const policy = consent.querySelector('a')!;
    expect(policy.getAttribute('href')).toBe('/privacy/');
    expect(policy.getAttribute('target')).toBe('_blank');
    expect(control(root, 'consent').checked).toBe(false);

    expect(field(root, 'human_check').querySelector('.yf-quiz-question')!.textContent).toBe('日本一高い山は?');
    expect(root.innerHTML).not.toContain('fujisan');
    expect(root.innerHTML).not.toContain('contact@example.jp');

    const honeypot = root.querySelector<HTMLInputElement>('input[name="hp_website"]')!;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.getAttribute('autocomplete')).toBe('off');
    expect(honeypot.closest('[aria-hidden="true"]')).not.toBeNull();

    // Required markers and aria-required follow the contract's requiredness.
    expect(field(root, 'name').querySelector('.yf-required')!.hidden).toBe(false);
    expect(control(root, 'name').getAttribute('aria-required')).toBe('true');
    expect(field(root, 'tel').querySelector('.yf-required')!.hidden).toBe(true);
    expect(root.querySelectorAll('.yf-steps li')).toHaveLength(3);
  });

  it('describes controls by their help and error text', async () => {
    const { root } = await mount(await definitionOf(example('full-coverage')));
    const file = control(root, 'attachments');
    expect(file.getAttribute('aria-describedby')).toContain(`${file.id}-help`);
    expect(file.getAttribute('aria-describedby')).toContain(`${file.id}-limits`);
    await submit(root);
    const name = control(root, 'name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toContain(`${name.id}-error`);
    expect(root.querySelector(`#${name.id}-error`)!.textContent).toBe('この項目は必須です。');
  });
});

describe('conditions', () => {
  it('shows and hides nodes and clears values of fields that become inactive', async () => {
    const { root } = await mount(await definitionOf(example('full-coverage')));
    expect(field(root, 'business').hidden).toBe(true);

    pick(root, 'customer_type', 'business');
    expect(field(root, 'business').hidden).toBe(false);
    type(root, 'company', '株式会社テスト');
    expect(field(root, 'company').querySelector('.yf-required')!.hidden).toBe(false);

    pick(root, 'customer_type', 'individual');
    expect(field(root, 'business').hidden).toBe(true);
    expect(control(root, 'company').value).toBe('');
    pick(root, 'customer_type', 'business');
    expect(control(root, 'company').value).toBe('');

    expect(field(root, 'interests_other').hidden).toBe(true);
    pick(root, 'interests', 'other');
    expect(field(root, 'interests_other').hidden).toBe(false);

    // requiredWhen follows the answer while visible
    const channels = control<HTMLSelectElement>(root, 'channels');
    channels.options[1]!.selected = true;
    channels.dispatchEvent(new Event('change'));
    expect(field(root, 'phone_time').hidden).toBe(false);
    expect(field(root, 'phone_time').querySelector('.yf-required')!.hidden).toBe(false);
  });

  it('clears errors of fields that become inactive', async () => {
    const { root } = await mount(await definitionOf(example('full-coverage')));
    pick(root, 'interests', 'other');
    await submit(root);
    expect(field(root, 'interests_other').getAttribute('data-yf-state')).toBe('invalid');
    pick(root, 'interests', 'other', false);
    expect(field(root, 'interests_other').hidden).toBe(true);
    expect(field(root, 'interests_other').getAttribute('data-yf-state')).toBeNull();
    expect(field(root, 'interests_other').querySelector('.yf-error')!.hidden).toBe(true);
  });

  it('detaches selected files when a file field becomes inactive', async () => {
    const declaration = simple({
      fields: [
        { key: 'has_files', type: 'checkbox', label: '資料を添付する', required: false },
        { key: 'docs', type: 'file', label: '資料', required: false, visibleWhen: { field: 'has_files', operator: 'eq', value: true }, validation: { maxFiles: 3 } },
      ],
    });
    const { root, server } = await mount(await definitionOf(declaration));
    check(root, 'has_files');
    attach(root, 'docs', [new File(['a'], 'a.pdf', { type: 'application/pdf' })]);
    attach(root, 'docs', [new File(['bb'], 'b.png', { type: 'image/png' })]);
    expect(field(root, 'docs').querySelectorAll('.yf-file-item')).toHaveLength(2);

    check(root, 'has_files', false);
    expect(field(root, 'docs').hidden).toBe(true);
    expect(field(root, 'docs').querySelectorAll('.yf-file-item')).toHaveLength(0);
    check(root, 'has_files');
    expect(field(root, 'docs').querySelectorAll('.yf-file-item')).toHaveLength(0);

    attach(root, 'docs', [new File(['c'], 'c.pdf', { type: 'application/pdf' })]);
    check(root, 'has_files', false);
    await submit(root);
    expect(server.posts[0]!.getAll('files[docs][]')).toEqual([]);
  });

  it('explains file limits as soon as files are chosen', async () => {
    const declaration = simple({ fields: [{ key: 'docs', type: 'file', label: '資料', required: false, validation: { maxFiles: 2, accept: ['pdf'] } }] });
    const { root } = await mount(await definitionOf(declaration));
    const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
    attach(root, 'docs', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    expect(field(root, 'docs').querySelector('.yf-error')!.textContent).toBe('ファイルは2個まで添付できます。');
    field(root, 'docs').querySelector<HTMLButtonElement>('.yf-file-remove')!.click();
    expect(field(root, 'docs').querySelector('.yf-error')!.hidden).toBe(true);
    attach(root, 'docs', [new File(['x'], 'x.png', { type: 'image/png' })]);
    expect(field(root, 'docs').querySelector('.yf-error')!.textContent).toBe('ファイルは2個まで添付できます。');
  });

  it('removes one attached file at a time', async () => {
    const declaration = simple({ fields: [{ key: 'docs', type: 'file', label: '資料', required: true, validation: { maxFiles: 3 } }] });
    const { root, server } = await mount(await definitionOf(declaration));
    attach(root, 'docs', [new File(['a'], 'a.pdf', { type: 'application/pdf' }), new File(['b'], 'b.pdf', { type: 'application/pdf' })]);
    const remove = field(root, 'docs').querySelector<HTMLButtonElement>('.yf-file-remove')!;
    expect(remove.getAttribute('aria-label')).toBe('a.pdf を削除');
    remove.click();
    expect([...field(root, 'docs').querySelectorAll('.yf-file-name')].map((e) => e.textContent)).toEqual(['b.pdf']);
    await submit(root);
    expect((server.posts[0]!.getAll('files[docs][]') as File[]).map((f) => f.name)).toEqual(['b.pdf']);
  });
});

describe('reflection, character count and kana', () => {
  it('reflects the source answer as text and hides with an inactive source', async () => {
    const declaration = simple({
      fields: [
        { key: 'show', type: 'checkbox', label: '表示', required: false },
        { key: 'note', type: 'text', label: 'メモ', required: false, visibleWhen: { field: 'show', operator: 'eq', value: true } },
        { key: 'note_echo', type: 'reflection', source: 'note', label: '確認' },
      ],
    });
    const { root } = await mount(await definitionOf(declaration));
    expect(field(root, 'note_echo').hidden).toBe(true);
    check(root, 'show');
    type(root, 'note', '<b>太字</b> & "引用"');
    const echo = field(root, 'note_echo');
    expect(echo.hidden).toBe(false);
    expect(echo.querySelector('.yf-reflection-value')!.textContent).toBe('<b>太字</b> & "引用"');
    expect(echo.querySelector('b')).toBeNull();
    check(root, 'show', false);
    expect(echo.hidden).toBe(true);
  });

  it('counts characters used or remaining in code points', async () => {
    const declaration = simple({
      fields: [
        { key: 'a', type: 'textarea', label: 'A', required: false, characterCount: 'used', validation: { maxLength: 10 } },
        { key: 'b', type: 'text', label: 'B', required: false, characterCount: 'remaining', validation: { maxLength: 3 } },
      ],
    });
    const { root } = await mount(await definitionOf(declaration));
    type(root, 'a', '𠮷野家');
    expect(field(root, 'a').querySelector('.yf-counter')!.textContent).toBe('3／10文字');
    type(root, 'b', 'あいうえ');
    expect(field(root, 'b').querySelector('.yf-counter')!.textContent).toBe('1文字オーバー');
  });

  it('normalizes a katakana preset on blur and explains invalid input', async () => {
    const { root } = await mount(await definitionOf(example('full-coverage')));
    type(root, 'name_kana', 'やまだ　たろう');
    blur(root, 'name_kana');
    expect(control(root, 'name_kana').value).toBe('ヤマダ タロウ');
    expect(field(root, 'name_kana').querySelector('.yf-error')!.hidden).toBe(true);
    type(root, 'name_kana', 'Yamada');
    blur(root, 'name_kana');
    expect(field(root, 'name_kana').querySelector('.yf-error')!.textContent).toBe('カタカナで入力してください。');
    type(root, 'postal_code', '１２３４５６７');
    blur(root, 'postal_code');
    expect(control(root, 'postal_code').value).toBe('123-4567');
  });
});

describe('client validation', () => {
  it('lists errors in a summary with links and focuses the first invalid control', async () => {
    const { root, server } = await mount(await definitionOf(simple()));
    type(root, 'name', 'とても長い名前でございます');
    await submit(root);
    expect(server.posts).toHaveLength(0);
    const summary = root.querySelector<HTMLElement>('.yf-error-summary')!;
    expect(summary.hidden).toBe(false);
    expect(summary.getAttribute('role')).toBe('alert');
    const links = [...summary.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['お名前：10文字以内で入力してください。', 'メールアドレス：この項目は必須です。']);
    expect(links[0]!.getAttribute('href')).toBe(`#${control(root, 'name').id}`);
    expect(document.activeElement).toBe(control(root, 'name'));

    type(root, 'name', '山田');
    expect(field(root, 'name').getAttribute('data-yf-state')).toBeNull();
  });
});

describe('the confirmation step (入力→確認→完了)', () => {
  it('confirms active answers, goes back to edit, then submits', async () => {
    const { root, server } = await mount(await definitionOf(example('full-coverage')));
    type(root, 'name', '山田 太郎');
    type(root, 'name_kana', 'ヤマダ タロウ');
    type(root, 'email', 'taro@example.jp');
    pick(root, 'customer_type', 'individual');
    choose(root, 'topic', 'estimate');
    type(root, 'message', 'お見積もりをお願いします。');
    type(root, 'human_check', '富士山');
    check(root, 'consent');
    await submit(root);

    expect(server.posts).toHaveLength(0);
    const confirm = root.querySelector<HTMLElement>('.yf-confirm')!;
    expect(confirm.hidden).toBe(false);
    expect(root.querySelector('form')!.hidden).toBe(true);
    expect(root.getAttribute('data-yf-state')).toBe('confirm');
    expect(confirm.querySelector('h2')!.textContent).toBe('入力内容の確認');
    expect(document.activeElement).toBe(confirm.querySelector('h2'));
    const rows = Object.fromEntries([...confirm.querySelectorAll('.yf-confirm-row')].map((r) => [r.querySelector('dt')!.textContent, r.querySelector('dd')!.textContent]));
    expect(rows).toMatchObject({ お名前: '山田 太郎', お問い合わせ区分: '個人', ご相談内容: 'お見積もり', 電話番号: '（未入力）', 個人情報の取り扱いに同意する: '同意する' });
    expect(rows).not.toHaveProperty('会社名');
    expect(rows).not.toHaveProperty('確認のため質問にお答えください');
    expect(root.querySelector('.yf-steps [aria-current="step"]')!.textContent).toBe('確認');

    confirm.querySelector<HTMLButtonElement>('.yf-back')!.click();
    expect(root.querySelector('form')!.hidden).toBe(false);
    expect(control(root, 'name').value).toBe('山田 太郎');
    await submit(root);
    confirm.querySelector<HTMLButtonElement>('.yf-submit')!.click();
    await settle();

    expect(server.posts).toHaveLength(1);
    const answers = answersOf(server.posts[0]!);
    expect(answers).toMatchObject({ name: '山田 太郎', topic: 'estimate', consent: true, newsletter: false, source: 'website' });
    expect(answers).not.toHaveProperty('budget');
    expect(answers.human_check).toEqual({ questionId: 'mount_fuji', answer: '富士山' });
    expect(answers).not.toHaveProperty('company');
    const success = root.querySelector<HTMLElement>('.yf-success')!;
    expect(success.hidden).toBe(false);
    expect(success.textContent).toBe('お問い合わせを受け付けました。担当者よりご連絡いたします。');
    expect(root.getAttribute('data-yf-state')).toBe('done');
    expect(root.querySelector('.yf-steps [aria-current="step"]')!.textContent).toBe('完了');
    expect(control(root, 'name').value).toBe('');
  });
});

describe('submission wire format', () => {
  it('posts version, answers, files, idempotency key and the honeypot as multipart', async () => {
    const declaration = simple({ fields: [...simple().fields, { key: 'docs', type: 'file', label: '資料', required: false, validation: { maxFiles: 2 } }] });
    const { root, server } = await mount(await definitionOf(declaration), [], { hidden: { source: 'lp-a', bogus: 'x' } } as Partial<MountConfig>);
    fillSimple(root);
    attach(root, 'docs', [new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }), new File(['x'], 'b.txt', { type: 'text/plain' })]);
    await submit(root);

    const body = server.posts[0]!;
    expect([...new Set([...body.keys()])]).toEqual(['version', 'answers', 'files[docs][]', 'idempotencyKey', 'hp_website']);
    expect(body.get('version')).toBe('3');
    expect(answersOf(body)).toEqual({ name: '山田', email: 'taro@example.jp', source: 'lp-a' });
    expect((body.getAll('files[docs][]') as File[]).map((f) => f.name)).toEqual(['a.pdf', 'b.txt']);
    expect(String(body.get('idempotencyKey'))).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(body.get('hp_website')).toBe('');
  });

  it('reuses the idempotency key and answer bytes on a retry, and makes a new one for changed answers', async () => {
    const { root, server } = await mount(await definitionOf(simple()), [new TypeError('offline'), rejected('temporarily_unavailable'), accepted()]);
    fillSimple(root);
    await submit(root);
    expect(notice(root)).toBe('通信に失敗したため、送信できませんでした。入力内容は保持されています。接続をご確認のうえ、もう一度お試しください。');
    expect(control(root, 'name').value).toBe('山田');
    await submit(root);
    expect(notice(root)).toBe(API_ERRORS.temporarily_unavailable.message);
    expect(server.posts[1]!.get('idempotencyKey')).toBe(server.posts[0]!.get('idempotencyKey'));
    expect(server.posts[1]!.get('answers')).toBe(server.posts[0]!.get('answers'));

    type(root, 'name', '山田花子');
    await submit(root);
    expect(server.posts[2]!.get('idempotencyKey')).not.toBe(server.posts[0]!.get('idempotencyKey'));
  });

  it('ignores a second click while a submission is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = fakeYatris(await definitionOf(simple()));
    const wrapped = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await gate;
      return server.fetch(url, init);
    });
    const root2 = document.createElement('div');
    document.body.append(root2);
    const controller: FormController = mountForm(root2, liveConfig('contact'), { fetch: wrapped as unknown as typeof fetch, navigate: vi.fn() });
    await controller.ready;
    fillSimple(root2);
    await submit(root2);
    expect(root2.getAttribute('data-yf-pending')).toBe('true');
    expect(root2.querySelector<HTMLButtonElement>('.yf-submit')!.disabled).toBe(true);
    expect(root2.querySelector('.yf-submit')!.textContent).toBe('送信中…');
    await submit(root2);
    release();
    await settle();
    await settle();
    expect(wrapped.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(root2.querySelector<HTMLElement>('.yf-success')!.hidden).toBe(false);
  });
});

describe('API error codes', () => {
  async function failWith(reply: Response, setup?: (root: HTMLElement) => void) {
    const ctx = await mount(await definitionOf(simple()), [reply, accepted()]);
    fillSimple(ctx.root);
    setup?.(ctx.root);
    await submit(ctx.root);
    return ctx;
  }

  it('validation_failed: shows field-keyed and form errors and focuses the first invalid field', async () => {
    const { root, navigate } = await failWith(rejected('validation_failed', { fieldErrors: { email: 'invalid_email' }, formErrors: ['too_many_files_total'] }));
    expect(field(root, 'email').querySelector('.yf-error')!.textContent).toBe('メールアドレスの形式が正しくありません。');
    expect([...root.querySelectorAll('.yf-error-summary li')].map((li) => li.textContent)).toEqual([
      'メールアドレス：メールアドレスの形式が正しくありません。',
      '添付できるファイル数の上限を超えています。',
    ]);
    expect(document.activeElement).toBe(control(root, 'email'));
    expect(navigate).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('.yf-success')!.hidden).toBe(true);
  });

  for (const code of ['idempotency_conflict', 'verification_failed', 'payload_too_large', 'temporarily_unavailable', 'form_unavailable'] as const) {
    it(`${code}: keeps the input and shows the stable message`, async () => {
      const { root, server } = await failWith(rejected(code));
      expect(notice(root)).toBe(API_ERRORS[code].message);
      expect(control(root, 'name').value).toBe('山田');
      expect(root.querySelector<HTMLElement>('.yf-success')!.hidden).toBe(true);
      expect(root.querySelector<HTMLButtonElement>('.yf-submit')!.disabled).toBe(false);
      await submit(root);
      const reused = server.posts[1]!.get('idempotencyKey') === server.posts[0]!.get('idempotencyKey');
      // Retryable failures reuse the key; the others need a fresh deliberate submission.
      expect(reused).toBe(code === 'verification_failed' || code === 'temporarily_unavailable');
    });
  }

  it('rate_limited: explains the wait from Retry-After and holds the button', async () => {
    const { root } = await failWith(rejected('rate_limited', {}, { 'retry-after': '30' }));
    expect(notice(root)).toBe(`${API_ERRORS.rate_limited.message}約30秒後に、もう一度お試しください。`);
    expect(root.querySelector<HTMLButtonElement>('.yf-submit')!.disabled).toBe(true);
  });

  it('an unknown 5xx without a body is temporarily_unavailable, never success', async () => {
    const { root, navigate } = await failWith(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(notice(root)).toBe(API_ERRORS.temporarily_unavailable.message);
    expect(navigate).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('.yf-success')!.hidden).toBe(true);
  });

  it('a 2xx without an accepted status is not a success', async () => {
    const { root } = await failWith(json(200, { ok: true }));
    expect(root.querySelector<HTMLElement>('.yf-success')!.hidden).toBe(true);
    expect(notice(root)).toBe(API_ERRORS.temporarily_unavailable.message);
  });

  it('form_version_changed: reloads, keeps compatible answers, marks changes and never resubmits', async () => {
    const v3 = await definitionOf(
      simple({
        fields: [
          { key: 'name', type: 'text', label: 'お名前', required: true },
          { key: 'email', type: 'email', label: 'メールアドレス', required: true },
          { key: 'plan', type: 'radio', label: 'プラン', required: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
          { key: 'agree', type: 'acceptance', label: '同意', required: true, consentText: '旧規約' },
          { key: 'old', type: 'text', label: '廃止', required: false },
        ],
      }),
    );
    const v4 = await definitionOf(
      simple({
        fields: [
          { key: 'name', type: 'text', label: 'お名前', required: true },
          { key: 'email', type: 'email', label: 'メールアドレス', required: true },
          { key: 'plan', type: 'radio', label: 'プラン', required: false, options: [{ value: 'a', label: 'A' }] },
          { key: 'agree', type: 'acceptance', label: '同意', required: true, consentText: '新規約' },
          { key: 'company', type: 'text', label: '会社名', required: false },
        ],
      }),
      { version: 4 },
    );
    const { root, server } = await mount([v3, v4], [rejected('form_version_changed')]);
    fillSimple(root);
    pick(root, 'plan', 'b');
    check(root, 'agree');
    type(root, 'old', '旧項目');
    await submit(root);

    expect(server.gets).toHaveLength(2);
    expect(server.gets[1]!.cache).toBe('no-cache');
    expect(server.posts).toHaveLength(1);
    expect(notice(root)).toBe(API_ERRORS.form_version_changed.message);
    expect(control(root, 'name').value).toBe('山田');
    expect(control(root, 'agree').checked).toBe(false);
    expect(field(root, 'old')).toBeNull();
    expect(field(root, 'plan').querySelector<HTMLInputElement>('input:checked')).toBeNull();
    const changed = [...root.querySelectorAll('[data-yf-changed="true"]')].map((e) => e.getAttribute('data-yf-field'));
    expect(changed).toEqual(['plan', 'agree', 'company']);
    expect(field(root, 'name').hasAttribute('data-yf-changed')).toBe(false);

    check(root, 'agree');
    await submit(root);
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1]!.get('version')).toBe('4');
    expect(server.posts[1]!.get('idempotencyKey')).not.toBe(server.posts[0]!.get('idempotencyKey'));
  });
});

describe('success', () => {
  const redirecting = () => simple({ success: { mode: 'redirect', redirectPath: '/contact/thanks/' } });

  it('redirects to the definition path only after an accepted response, and clears the form', async () => {
    const { root, navigate } = await mount(await definitionOf(redirecting()), [rejected('validation_failed', { fieldErrors: { name: 'too_long' } }), accepted()]);
    fillSimple(root);
    await submit(root);
    expect(navigate).not.toHaveBeenCalled();
    type(root, 'name', '山田');
    await submit(root);
    expect(navigate).toHaveBeenCalledWith('/contact/thanks/');
    expect(control(root, 'name').value).toBe('');
    expect(control(root, 'email').value).toBe('');
  });

  it('never follows a destination from the response', async () => {
    const { root, navigate } = await mount(await definitionOf(redirecting()), [json(202, { status: 'accepted', receipt: 'r', success: { mode: 'redirect', path: 'https://evil.example/' } })]);
    fillSimple(root);
    await submit(root);
    expect(navigate).toHaveBeenCalledWith('/contact/thanks/');
  });
});

describe('Turnstile', () => {
  function fakeTurnstile(token: string | undefined) {
    const api = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn(), getResponse: vi.fn(() => token) };
    return { api, loader: vi.fn(async () => api as TurnstileApi) };
  }

  it('loads only when the definition asks, sends the token and resets it after a failure', async () => {
    const { api, loader } = fakeTurnstile('tok-123');
    const definition = await definitionOf(simple(), { turnstile: { siteKey: '0x4AAA', action: 'contact' } });
    const { root, server } = await mount(definition, [rejected('verification_failed'), accepted()], {}, { turnstile: loader });
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(api.render).toHaveBeenCalledWith(root.querySelector('.yf-turnstile'), expect.objectContaining({ sitekey: '0x4AAA', action: 'contact', language: 'ja' }));
    fillSimple(root);
    await submit(root);
    expect(server.posts[0]!.get('turnstileToken')).toBe('tok-123');
    expect(notice(root)).toBe(API_ERRORS.verification_failed.message);
    expect(api.reset).toHaveBeenCalledWith('w1');
    expect(control(root, 'name').value).toBe('山田');
  });

  it('does not submit without a token', async () => {
    const { loader } = fakeTurnstile(undefined);
    const definition = await definitionOf(simple(), { turnstile: { siteKey: '0x4AAA', action: 'contact' } });
    const { root, server } = await mount(definition, [], {}, { turnstile: loader });
    await settle();
    fillSimple(root);
    await submit(root);
    expect(server.posts).toHaveLength(0);
    expect(notice(root)).toBe('送信前の確認が完了していません。確認が終わるまでお待ちください。');
  });

  it('is never loaded for a definition without Turnstile', async () => {
    const { loader } = fakeTurnstile('t');
    await mount(await definitionOf(simple()), [], {}, { turnstile: loader });
    expect(loader).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });
});

describe('loading and unavailable states', () => {
  it('refuses a definition that needs a capability this renderer lacks', async () => {
    const definition = { ...(await definitionOf(simple())), capabilities: ['field:text', 'field:signature'] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root } = await mount(definition);
    expect(root.getAttribute('data-yf-state')).toBe('unavailable');
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('.yf-unavailable')!.textContent).toContain('このフォームは現在表示できません');
    expect(warn.mock.calls[0]![0]).toContain('field:signature');
  });

  it('refuses another contract version and unknown node types', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await definitionOf(simple());
    expect((await mount({ ...base, contractVersion: 2 } as unknown as PublicDefinition)).root.querySelector('form')).toBeNull();
    const unknownType = { ...base, fields: [...base.fields, { key: 'sig', type: 'signature' }] } as unknown as PublicDefinition;
    expect((await mount(unknownType)).root.querySelector('form')).toBeNull();
  });

  it('refuses a submission endpoint on another origin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await definitionOf(simple());
    const { root } = await mount({ ...base, submission: { ...base.submission, endpoint: 'https://evil.example/collect' } });
    expect(root.querySelector('form')).toBeNull();
  });

  it('explains a missing form without a retry, and offers a retry after a network failure', async () => {
    const gone = await mount(() => json(404, { status: 'rejected', code: 'form_unavailable' }));
    expect(gone.root.querySelector('.yf-unavailable')!.textContent).toBe('このフォームは現在ご利用いただけません。');
    expect(gone.root.querySelector('.yf-retry')).toBeNull();

    const definition = await definitionOf(simple());
    let fail = true;
    const flaky = await mount(() => {
      if (fail) throw new TypeError('offline');
      return json(200, definition);
    });
    expect(flaky.root.querySelector('.yf-unavailable')!.textContent).toContain('フォームを読み込めませんでした');
    fail = false;
    flaky.root.querySelector<HTMLButtonElement>('.yf-retry')!.click();
    await settle();
    await settle();
    expect(flaky.root.querySelector('form')).not.toBeNull();
  });

  it('shows the unavailable state for an unconfigured mount without any request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = document.createElement('div');
    const fetch = vi.fn();
    const controller = mountForm(root, { mode: 'unconfigured', form: 'contact', timeZone: 'Asia/Tokyo', reason: 'not paired' }, { fetch: fetch as unknown as typeof globalThis.fetch });
    await controller.ready;
    expect(fetch).not.toHaveBeenCalled();
    expect(root.getAttribute('data-yf-state')).toBe('unavailable');
  });
});

describe('mountAll', () => {
  function placeMount(config: MountConfig) {
    const root = document.createElement('div');
    root.setAttribute('data-yatris-form', config.form);
    const script = document.createElement('script');
    script.type = 'application/json';
    script.setAttribute('data-yf-config', '');
    script.textContent = JSON.stringify(config);
    root.append(script);
    document.body.append(root);
    return root;
  }

  it('never falls back to preview: a preview mount without the preview module is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const definition = await definitionOf(simple());
    const root = placeMount({ mode: 'preview', form: 'contact', timeZone: 'Asia/Tokyo', source: 'src/forms/contact.json', definition });
    const [controller] = mountAll(null);
    await controller!.ready;
    expect(root.getAttribute('data-yf-state')).toBe('unavailable');
    expect(root.querySelector('form')).toBeNull();
  });

  it('mounts each form once', async () => {
    const definition = await definitionOf(simple());
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, definition));
    placeMount(liveConfig('contact'));
    const first = mountAll(null);
    await first[0]!.ready;
    expect(mountAll(null)).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(`${ORIGIN}/api/v1/forms/42.contact`);
  });
});

describe('preview', () => {
  it('marks the form as a preview and answers locally, sending nothing', async () => {
    const definition = await toPublicDefinition(simple(), { publicKey: 'preview.contact', version: 1, endpoint: 'preview:submissions', turnstile: null });
    const config: MountConfig = { mode: 'preview', form: 'contact', timeZone: 'Asia/Tokyo', source: 'src/forms/contact.json', definition };
    const network = vi.spyOn(globalThis, 'fetch');
    const preview = createPreview(config);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = mountForm(root, config, { fetch: preview.fetch, decorate: preview.decorate, navigate: vi.fn() });
    await controller.ready;

    const marker = root.querySelector('.yf-preview-marker')!;
    expect(marker.textContent).toContain('プレビュー表示：src/forms/contact.json');
    expect(marker.textContent).toContain('送信・メール送信は行われません');
    expect(root.getAttribute('data-yf-preview')).toBe('true');

    preview.scenario = 'validation_failed';
    fillSimple(root);
    await submit(root);
    expect(field(root, 'name').querySelector('.yf-error')!.textContent).toBe('入力形式が正しくありません。');

    preview.scenario = 'accepted';
    type(root, 'name', '山田');
    await submit(root);
    expect(root.querySelector<HTMLElement>('.yf-success')!.textContent).toBe('ありがとうございました。');
    expect(preview.requests).toHaveLength(2);
    expect(JSON.parse(String(preview.requests[1]!.answers))).toMatchObject({ name: '山田' });
    expect(network).not.toHaveBeenCalled();
  });

  it('offers a redirect, a version change and a network failure as scenarios', async () => {
    const definition = await toPublicDefinition(simple({ success: { mode: 'redirect', redirectPath: '/thanks/' } }), { publicKey: 'preview.contact', version: 1, endpoint: 'preview:submissions', turnstile: null });
    const config: MountConfig = { mode: 'preview', form: 'contact', timeZone: 'Asia/Tokyo', source: 'src/forms/contact.json', definition };
    const preview = createPreview(config);
    const root = document.createElement('div');
    document.body.append(root);
    const navigate = vi.fn();
    const controller = mountForm(root, config, { fetch: preview.fetch, decorate: preview.decorate, navigate });
    await controller.ready;
    fillSimple(root);

    preview.scenario = 'network';
    await submit(root);
    expect(notice(root)).toContain('通信に失敗したため');
    preview.scenario = 'form_version_changed';
    await submit(root);
    expect(notice(root)).toBe(API_ERRORS.form_version_changed.message);
    preview.scenario = 'accepted';
    await submit(root);
    expect(preview.requests.at(-1)!.version).toBe('2');
    expect(navigate).toHaveBeenCalledWith('/thanks/');
  });
});
