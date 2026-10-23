const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '../app/api/bot');
function load(name, dependencies = {}, extra = '') {
  const filename = path.join(root, name);
  const localRequire = createRequire(filename);
  const sandbox = {
    exports: {}, console, URL, Buffer,
    process: { env: { TELEGRAM_BOT_TOKEN: '123456:test-token' } },
    require: (id) => dependencies[id] ?? localRequire(id),
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8') + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox, { filename });
  return sandbox.exports;
}

test('restrictions expire at one hour, unblock early, and opaque codes resolve', () => {
  const { createModerationStore } = load('moderation.ts');
  let now = 1_000;
  const store = createModerationStore(() => now);
  const code = store.codeFor(123456789);
  assert.match(code, /^U-[A-F0-9]{12}$/);
  assert.equal(store.codeFor(123456789), code);
  assert.equal(store.userFor(code.toLowerCase()), 123456789);
  const anonymousLabel = store.labelFor(123456789);
  assert.equal(anonymousLabel, '#' + code.replace('-', '_'));
  assert.equal(store.userFor(anonymousLabel), 123456789);
  store.setDisplay(123456789, true, 'example_user');
  assert.equal(store.labelFor(123456789), '@example_user');
  assert.equal(store.userFor('@example_user'), 123456789);
  const restored = createModerationStore(() => now);
  restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
  assert.equal(restored.labelFor(123456789), '@example_user');
  store.setDisplay(123456789, false);
  assert.equal(store.labelFor(123456789), anonymousLabel);
  assert.equal(store.userFor('@example_user'), undefined);
  store.setDisplay(123456789, true);
  assert.equal(store.labelFor(123456789), '123456789');
  store.setDisplay(123456789, false);
  assert.notEqual(store.codeFor(2), code);
  store.ban1h(123456789);
  now += 3_599_999;
  assert.notEqual(store.status(123456789), undefined);
  now++;
  assert.equal(store.status(123456789), undefined);
  assert.equal(store.list().length, 0);
  store.block(123456789);
  now += 9_000_000;
  assert.equal(store.status(123456789), null);
  store.unblock(123456789);
  assert.equal(store.status(123456789), undefined);
  store.ban1h(2);
  store.unblock(2);
  assert.equal(store.list().length, 0);
});

test('group commands enforce admin checks, notify, list private codes, and guard all input', async () => {
  const moderationModule = load('moderation.ts');
  const { bot, moderation, buildGroupMessage } = load('route.ts', {
    './moderation': moderationModule,
    './pinned-moderation': load('pinned-moderation.ts'),
  }, '\nexport { bot, moderation, buildGroupMessage };');
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Bot', username: 'test_bot' };
  const calls = [];
  let admin = true;
  let notificationFails = false;
  let pinned;
  const messages = new Map();
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChat') return { ok: true, result: { pinned_message: pinned } };
    if (method === 'editMessageText') {
      pinned.text = payload.text;
      return { ok: true, result: pinned };
    }
    if (method === 'pinChatMessage') {
      pinned = messages.get(payload.message_id);
      return { ok: true, result: true };
    }
    if (method === 'getChatMember') return { ok: true, result: { status: admin ? 'administrator' : 'member' } };
    if (notificationFails && method === 'sendMessage' && payload.chat_id === 42) throw new Error('blocked by recipient');
    const result = { message_id: sequence * 100 + calls.length, from: bot.botInfo, text: payload.text };
    if (method === 'sendMessage') messages.set(result.message_id, result);
    return { ok: true, result: method === 'answerCallbackQuery' ? true : result };
  });
  let sequence = 0;
  async function message(text, group = true, extra = {}) {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++sequence, message: {
      message_id: sequence, date: 0,
      chat: { id: group ? -1002825832693 : 42, type: group ? 'supergroup' : 'private' },
      from: { id: group ? 7 : 42, is_bot: false, first_name: 'Private Name' },
      ...(text === undefined ? {} : { text }), ...extra,
    } });
  }
  const textCalls = () => calls.filter(c => c.method === 'sendMessage');
  const code = moderation.codeFor(42);
  const groupMessage = buildGroupMessage({ step: 'awaiting_message', mode: 'anonymous', topic: 'feedback' }, 'hello', {
    id: 42, first_name: 'Private Name', username: 'private_username',
  });
  assert.ok(groupMessage.includes(moderation.labelFor(42)));
  assert.ok(!groupMessage.includes('Private Name') && !groupMessage.includes('private_username'));
  admin = false;
  await message('/block ' + code);
  assert.equal(moderation.status(42), undefined);
  await message('/blockList', true, {
    sender_chat: { id: -1002825832693, type: 'supergroup', title: 'Support' },
  });
  assert.ok(calls.some(c => c.method === 'pinChatMessage'));
  assert.ok(pinned.text.includes('/blockList') && pinned.text.includes('/ban1h'));
  assert.ok(!calls.some(c => c.method === 'getChatMember'));
  assert.equal(moderation.status(42), undefined);
  admin = true;
  await message('/block ' + code, true, {
    sender_chat: { id: -100777, type: 'channel', title: 'Other channel' },
  });
  assert.equal(moderation.status(42), undefined);
  assert.ok(!calls.some(c => c.method === 'getChat'));
  await message('/block@test_bot ' + code);
  assert.equal(moderation.status(42), null);
  assert.ok(textCalls().some(c => c.payload.chat_id === 42));
  await message('hello', false);
  assert.ok(textCalls().every(c => c.payload.chat_id === 42));
  await message(undefined, false, { document: { file_id: 'pdf', file_unique_id: 'pdf', mime_type: 'application/pdf' } });
  assert.ok(!calls.some(c => c.method === 'forwardMessage'));
  calls.length = 0;
  await bot.handleUpdate({ update_id: ++sequence, callback_query: {
    id: 'cb', chat_instance: 'chat', from: { id: 42, is_bot: false, first_name: 'User' },
    data: 'reply:anonymous:telegram',
    message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } },
  } });
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery'));
  assert.ok(!calls.some(c => c.method === 'sendMessage'));
  await message('/blockList');
  assert.ok(textCalls()[0].payload.text.includes(moderation.labelFor(42)));
  assert.ok(!textCalls()[0].payload.text.includes('Private Name'));
  await message('/unblock ' + code);
  assert.equal(moderation.status(42), undefined);
  await message('/block ' + code, true, {
    sender_chat: { id: -1002825832693, type: 'supergroup', title: 'Support' },
  });
  assert.equal(moderation.status(42), null);
  await message('/unblock ' + code);
  await message('/ban1h', true, { reply_to_message: {
    message_id: 100, from: bot.botInfo, text: groupMessage,
  } });
  assert.ok(moderation.status(42) > Date.now());
  notificationFails = true;
  await message('/block ' + code);
  assert.equal(moderation.status(42), null);
  assert.ok(textCalls().at(-1).payload.text.includes('ناموفق'));
  notificationFails = false;
  await message('/unblock ' + code);
  await message('/block U-UNKNOWN');
  assert.equal(moderation.status(42), undefined);
  await message('/block', true, { reply_to_message: { message_id: 200, from: { id: 8 }, text: groupMessage } });
  assert.equal(moderation.status(42), undefined);
  await message('/start', false);
  assert.ok(textCalls()[0].payload.reply_markup.keyboard);
  async function submitFeedback(mode) {
    await bot.handleUpdate({ update_id: ++sequence, callback_query: {
      id: 'feedback-' + sequence, chat_instance: 'chat',
      from: { id: 42, is_bot: false, first_name: 'User' },
      data: 'topic:' + mode + ':feedback',
      message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } },
    } });
    await message('hello', false, { from: {
      id: 42, is_bot: false, first_name: 'Private Name', username: 'example_user',
    } });
  }
  await submitFeedback('identified');
  assert.ok(textCalls().some(c => c.payload.text.includes('شناسه کاربر: @example_user')));
  await message('/block @example_user');
  assert.equal(moderation.status(42), null);
  assert.ok(textCalls().at(-1).payload.text.includes('@example_user'));
  await message('/unblock @example_user');
  await submitFeedback('anonymous');
  const relayed = textCalls().find(c => c.payload.chat_id === '-1002825832693');
  assert.ok(relayed.payload.text.includes('#U_'));
  assert.ok(!relayed.payload.text.includes('example_user'));
  await message('/block ' + moderation.labelFor(42));
  assert.equal(moderation.status(42), null);
  assert.ok(!textCalls().at(-1).payload.text.includes('example_user'));
  await message('/unblock ' + moderation.labelFor(42));
  assert.equal(moderation.status(42), undefined);
});

test('pinned message restores codes and blocks after restart, with encrypted authenticated data', async () => {
  const { createModerationStore } = load('moderation.ts');
  const { createPinnedModeration } = load('pinned-moderation.ts');
  let pinned;
  let text;
  let failEdit = false;
  const api = {
    async getChat() { return { pinned_message: pinned }; },
    async sendMessage(_id, value) { text = value; return { message_id: 1 }; },
    async pinChatMessage() { pinned = { message_id: 1, from: { id: 999 }, text }; },
    async editMessageText(_id, _message, value) {
      if (failEdit) throw new Error('denied');
      pinned.text = value;
    },
  };
  const store = createModerationStore();
  const storage = createPinnedModeration(api, '-100', 'secret', store, () => 999);
  await assert.rejects(storage.run(false, async () => {}));
  const code = store.codeFor(123456789);
  await storage.run(true, async () => {
    store.block(123456789);
    store.ban1h(987654321);
    await storage.save();
  });
  for (const command of ['/block', '/unblock', '/ban1h', '/blockList']) assert.ok(pinned.text.includes(command));
  assert.ok(pinned.text.includes(store.labelFor(123456789)));
  assert.ok(!pinned.text.includes('123456789') && !pinned.text.includes('987654321'));
  const restarted = createModerationStore();
  const storage2 = createPinnedModeration(api, '-100', 'secret', restarted, () => 999);
  await storage2.run(false, async () => {
    assert.equal(restarted.status(123456789), null);
    assert.equal(restarted.userFor(code), 123456789);
    assert.ok(restarted.status(987654321) > Date.now());
  });
  failEdit = true;
  await assert.rejects(storage2.run(false, async () => {
    restarted.unblock(123456789);
    await storage2.save();
  }));
  assert.equal(restarted.status(123456789), null);
  failEdit = false;
  const savedText = pinned.text;
  pinned.text = savedText.replace('BOT_MODERATION_V1:', 'BOT_MODERATION_V1:AAAA');
  await assert.rejects(storage2.run(false, async () => {}));
  pinned = { message_id: 2, from: { id: 7 }, text: savedText };
  await assert.rejects(storage2.run(false, async () => {}));
  pinned = { message_id: 1, from: { id: 999 }, text: savedText };
  await storage2.run(false, async () => {
    restarted.unblock(123456789);
    await storage2.save();
  });
  const again = createModerationStore();
  const storage3 = createPinnedModeration(api, '-100', 'secret', again, () => 999);
  await storage3.run(false, async () => assert.equal(again.status(123456789), undefined));
  await assert.rejects(storage3.run(false, async () => {
    for (let i = 1; i < 500; i++) again.codeFor(i);
    await storage3.save();
  }));
  assert.equal(again.userFor(code), 123456789);
});

test('main menu stays available and flows recover across fresh server instances', async () => {
  let pinned;
  let sequence = 0;
  let messageId = 0;
  const calls = [];
  let visibleKeyboard;
  function restart() {
    const runtime = load('route.ts', {
      './moderation': load('moderation.ts'),
      './pinned-moderation': load('pinned-moderation.ts'),
    }, '\nexport { bot };');
    runtime.bot.botInfo = { id: 999, is_bot: true, first_name: 'Bot', username: 'test_bot' };
    runtime.bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload });
      if (method === 'sendMessage' && payload.chat_id === 42 && payload.reply_markup?.keyboard) {
        visibleKeyboard = payload.reply_markup.keyboard;
      }
      if (method === 'getChat') return { ok: true, result: { pinned_message: pinned } };
      if (method === 'getChatMember') return { ok: true, result: { status: 'administrator' } };
      if (method === 'editMessageText') pinned.text = payload.text;
      const result = { message_id: ++messageId, from: runtime.bot.botInfo, text: payload.text };
      if (method === 'sendMessage' && payload.text.includes('BOT_MODERATION_V1:')) pinned = result;
      return { ok: true, result };
    });
    return runtime.bot;
  }
  async function send(text, group = false, extra = {}) {
    calls.length = 0;
    // Every request runs on a new instance, including the final unthreaded text.
    await restart().handleUpdate({ update_id: ++sequence, message: {
      message_id: sequence, date: 0,
      chat: { id: group ? -1002825832693 : 42, type: group ? 'supergroup' : 'private' },
      from: { id: group ? 7 : 42, is_bot: false, first_name: 'User', username: 'example_user' },
      ...(text === undefined ? {} : { text }), ...extra,
    } });
  }
  const mainLabels = [
    '💬 ارسال پیام به صورت شناس', '🔒 ارسال پیام به صورت ناشناس',
    '📄 ارسال فایل پی‌دی‌اف', '🌐 لینک سایت', 'ℹ️ درباره ما',
  ];
  function assertMenu() {
    const reply = calls.findLast(c => c.method === 'sendMessage' && c.payload.chat_id === 42);
    const buttons = visibleKeyboard.flat().map(b => b.text);
    for (const label of mainLabels) assert.ok(buttons.includes(label), label);
    assert.equal(reply.payload.reply_markup.force_reply, undefined);
    assert.equal(reply.payload.reply_markup.remove_keyboard, undefined);
    return reply;
  }
  const relayed = () => calls.filter(c => c.method === 'sendMessage' && c.payload.chat_id === '-1002825832693');
  await send('/blockList', true);
  await send('/start');
  assertMenu();
  for (const mode of ['identified', 'anonymous']) {
    for (const topic of ['feedback', 'telegram', 'current_app']) {
      await send(mainLabels[mode === 'identified' ? 0 : 1]);
      const topics = assertMenu().payload.reply_markup;
      assert.equal(topics.keyboard, undefined);
      assert.deepEqual(Array.from(topics.inline_keyboard[0], b => b.callback_data), [
        `topic:${mode}:question`, `topic:${mode}:feedback`,
      ]);
      await send(topic === 'feedback' ? 'انتقادات و پیشنهادات' : 'طرح سوال');
      assertMenu();
      if (topic !== 'feedback') {
        const prompt = assertMenu().payload;
        assert.equal(prompt.text, 'مایل به دریافت پاسخ در 📨');
        assert.equal(prompt.reply_markup.keyboard, undefined);
        const choices = Array.from(prompt.reply_markup.inline_keyboard[0], button => button.text);
        assert.deepEqual(choices, ['تلگرام', 'برنامه جاری']);
        assert.deepEqual(Array.from(prompt.reply_markup.inline_keyboard[0], b => b.callback_data), [
          `reply:${mode}:telegram`, `reply:${mode}:current_app`,
        ]);
        await send(topic === 'telegram' ? 'تلگرام' : 'برنامه جاری');
        assertMenu();
      }
      await send('hello');
      assertMenu();
      assert.equal(relayed().length, 1);
      assert.ok(relayed()[0].payload.text.includes(mode === 'identified' ? '👤 شناس' : '🔒 ناشناس'));
      if (topic !== 'feedback') assert.ok(relayed()[0].payload.text.includes(topic === 'telegram' ? '📲' : '💬'));
      await send('already sent');
      assert.equal(relayed().length, 0);
      assertMenu();
    }
  }
  await send(mainLabels[0]);
  await send('طرح سوال');
  await send('در تلگرام هستم');
  // A main-menu button sent as a reply to a legacy ForceReply prompt is navigation.
  await send(mainLabels[2], false, { reply_to_message: {
    message_id: 123, from: { id: 999 }, text: 'پیام خود را وارد نمایید. 📝',
    entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://t.me/test_bot?start=flow_identified_question_telegram' }],
  } });
  assert.equal(relayed().length, 0);
  assert.ok(assertMenu().payload.text.includes('PDF'));
  await send('text instead of PDF');
  assertMenu();
  assert.equal(relayed().length, 0);
  await send(mainLabels[1]);
  await send('انتقادات و پیشنهادات');
  await send(undefined, false, { sticker: { file_id: 'sticker', file_unique_id: 'sticker' } });
  assertMenu();
  await send(mainLabels[4]);
  assertMenu();
  assert.equal(relayed().length, 0);
  await send('/start');
  assertMenu();
});
