import { mobileApi, setupMobilePanel } from './network.js';
import { CARD_NAME, CARD, ARCHIVE_SYSTEM, VERIFY_SYSTEM, MERGE_SYSTEM, contextPacket, relevantNotes, TURN_RULES } from './prompts.js';
const ctx = () => SillyTavern.getContext();
let activeBook, busy = false, cancelled = false, panel;
const settings = () => ctx().chatMetadata.novelWorkshopMobile || {};
const wait = ms => new Promise(r => setTimeout(r, ms));

const api = mobileApi;

function status(text) { if (panel) panel.querySelector('#nmw-status').textContent = text; }
async function updateSettings(patch) { ctx().chatMetadata.novelWorkshopMobile = { ...settings(), ...patch }; await ctx().saveMetadata(); }
function isCard() { return ctx().characters[ctx().characterId]?.name === CARD_NAME; }
function checkChat() { if (ctx().characterId === undefined || ctx().characterId === null || ctx().groupId) throw new Error('请先打开“小说续写工坊·移动版”角色的单人聊天'); }
function refreshPrompt() {
    ctx().setExtensionPrompt('novel-workshop-mobile', activeBook && isCard() ? contextPacket(activeBook, settings()) : '', 1, 1, false, 0);
}
async function restore() {
    activeBook = null;
    if (settings().bookId && isCard()) {
        try { activeBook = await api(`/book/${settings().bookId}`); } catch (e) { status(e.message); }
    }
    refreshPrompt();
}
async function analyzeChapter(c, book) {
    if (c.summary?.startsWith('【证据档案v2】')) return c.summary;
    const chunks = [];
    for (let offset = 0; offset < c.text.length; offset += 9000) chunks.push(c.text.slice(offset, offset + 9000));
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
        if (cancelled) throw new Error('已暂停，已保存的正文和档案可继续读取');
        const answer = await ctx().generateRaw({ systemPrompt: ARCHIVE_SYSTEM, prompt: `书名：${book.title}。目录第${c.index + 1}项《${c.title}》，本章第${i + 1}/${chunks.length}段。\n<正文资料>\n${chunks[i]}\n</正文资料>`, responseLength: 1800 });
        if (!answer.trim()) throw new Error('模型返回空档案，未标记为已分析');
        const verified = await ctx().generateRaw({ systemPrompt: VERIFY_SYSTEM, prompt: `第${c.index + 1}项《${c.title}》，第${i + 1}/${chunks.length}段。\n<正文>\n${chunks[i]}\n</正文>\n<候选档案>\n${answer}\n</候选档案>`, responseLength: 2000 });
        if (!verified.trim()) throw new Error('校核返回空内容，未保存未校核档案');
        notes.push(verified);
    }
    const summary = '【证据档案v2】\n' + (notes.length === 1 ? notes[0] : await ctx().generateRaw({ systemPrompt: ARCHIVE_SYSTEM, prompt: `同一章各段的证据档案，请合并，保留因果和章节编号：\n${notes.join('\n\n')}`, responseLength: 2000 }));
    await api('/summary', { id: book.id, index: c.index, summary });
    return summary;
}
async function merge(book, through) {
    const pending = book.chapters.slice(book.bibleThrough || 0, through).filter(c => c.summary);
    if (!pending.length) return;
    const bible = await ctx().generateRaw({ systemPrompt: MERGE_SYSTEM, prompt: `<旧档案>\n${book.bible || '无'}\n</旧档案>\n<新章节证据>\n${pending.map(c => `第${c.index + 1}项：${c.summary}`).join('\n\n')}\n</新章节证据>`, responseLength: 4000 });
    if (!bible.trim()) throw new Error('模型返回空总档案');
    await api('/bible', { id: book.id, bible, through }); book.bible = bible; book.bibleThrough = through;
}
export async function importNovel(url, count = 6, options = {}) {
    checkChat();
    if (!isCard()) throw new Error('请先选择“小说续写工坊·移动版”角色');
    if (busy) throw new Error('正在读取，请等待或暂停');
    const owner = ctx().getCurrentChatId();
    busy = true; cancelled = false;
    try {
        status('正在解析目录……');
        const book = await api('/discover', { url, mode: options.mode || 'auto', selector: options.selector || '' });
        if (ctx().getCurrentChatId() !== owner) throw new Error('聊天已切换，请回到原聊天重新读取');
        activeBook = book;
        await updateSettings({ bookId: book.id, pov: settings().pov || 'third' });
        const limit = count === 'all' ? book.chapters.length : Math.min(book.chapters.length, Math.max(1, Number(count) || 6));
        if (book.chapters.slice(0, limit).some(c => c.summary && !c.summary.startsWith('【证据档案v2】'))) { book.bible = ''; book.bibleThrough = 0; }
        for (let i = 0; i < limit; i++) {
            if (cancelled) throw new Error('已暂停，可继续读取');
            if (ctx().getCurrentChatId() !== owner) throw new Error('聊天已切换，任务已暂停，缓存已保留');
            const entry = book.chapters[i];
            if (!entry.summary?.startsWith('【证据档案v2】')) {
                status(`《${book.title}》目录共${book.chapters.length}章；正在读取/分析 ${i + 1}/${limit}：${entry.title}`);
                const chapter = await api('/chapter', { id: book.id, index: i, mode: options.mode, selector: options.selector });
                const summary = await analyzeChapter(chapter, book);
                Object.assign(entry, { summary, chars: chapter.text.length, method: chapter.method });
                await wait(650);
            }
            if (i + 1 - (book.bibleThrough || 0) >= 4) { status(`正在合并前${i + 1}章的故事档案……`); await merge(book, i + 1); }
        }
        await merge(book, limit);
        refreshPrompt();
        status(`已就绪：《${book.title}》目录${book.chapters.length}章，已分析${book.chapters.filter(c => c.summary).length}章，总档案覆盖前${book.bibleThrough}章。可生成续写场景。`);
        await library();
        return book;
    } catch (e) { status(`未完成：${e.message}`); refreshPrompt(); throw e; }
    finally { busy = false; }
}
async function library() {
    const select = panel?.querySelector('#nmw-library'); if (!select) return;
    select.replaceChildren(new Option('选择已保存的小说……', ''));
    for (const b of await api('/library')) select.add(new Option(`${b.title}（已分析${b.analyzed}/${b.total}章）`, b.id));
}
async function appendAssistant(text) {
    const c = ctx(); const msg = { name: c.name2, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: text, extra: { novel_workshop: true } };
    c.chat.push(msg); c.addOneMessage(msg); await c.saveChat();
}
async function offerScenes() {
    if (busy) throw new Error('请等待读取完成');
    if (!activeBook?.bible) throw new Error('请先读取并分析至少一章小说');
    busy = true;
    try {
        status('正在根据已读原著生成续写场景……');
        const owner = ctx().getCurrentChatId();
        const text = await ctx().generateRaw({ systemPrompt: CARD, prompt: `${contextPacket(activeBook, settings())}\n请给出三个可选择的具体续写场景（每个约100字），包括时间地点、冲突、可代入角色和分歧点；允许自定义。若设置已指定场景，则只围绕该场景提供三个不同切入方式。`, responseLength: 1800 });
        if (ctx().getCurrentChatId() !== owner) throw new Error('聊天已切换，未写入场景');
        await appendAssistant(text); status('场景已写入聊天，请在聊天框选择，或自定义场景。'); return text;
    } finally { busy = false; }
}
export async function intercept(chat, _size, abort, type) {
    if (!isCard() || type === 'quiet') return;
    if (busy) { abort(true); toastr.info('小说工坊正在读取，请等待或暂停后发送'); return; }
    const last = [...chat].reverse().find(m => m.is_user);
    const url = last?.mes?.match(/https?:\/\/[^\s<>"'）)]+/)?.[0]?.replace(/[，。；！？、]+$/, '');
    if (/mobile_web_(?:read|search)|不续写|(?:读取|查看|总结|概括).{0,6}(?:网页|网站)|联网.{0,4}(?:搜索|查询)/.test(last?.mes || '')) { ctx().setExtensionPrompt('novel-workshop-mobile', '', 1, 1); return; }
    try {
        const pov = last?.mes?.match(/(?:^|切换|改用|采用|我要|我想|选择|使用|用)\s*(第一|第三)人称/);
        if (pov) await updateSettings({ pov: pov[1] === '第一' ? 'first' : 'third' });
        if (url && (url !== activeBook?.url || !activeBook?.bible)) {
            await importNovel(url, Number(panel?.querySelector('#nmw-count').value) || 6, { mode: panel?.querySelector('#nmw-mode').value || 'auto', selector: panel?.querySelector('#nmw-selector').value || '' });
        }
        if (activeBook) {
            refreshPrompt();
            // coreChat is constructed before this interceptor; add the packet directly for this request.
            chat.unshift({ is_user: false, is_system: true, name: '小说证据档案', mes: contextPacket(activeBook, settings()) + relevantNotes(activeBook, last?.mes), extra: {} });
            chat.push({ is_user: false, is_system: true, name: '本轮镜头约束', mes: TURN_RULES, extra: {} });
        }
    } catch (e) { abort(true); toastr.error(e.message, '小说未读取成功', { timeOut: 12000 }); }
}
function guarded(fn) { return async () => { try { await fn(); } catch (e) { status(e.message); toastr.error(e.message, '小说工坊'); } }; }
export function init() {
    if (document.getElementById('novel-workshop-mobile-panel')) return;
    panel = document.createElement('section'); panel.id = 'novel-workshop-mobile-panel'; panel.hidden = true;
    panel.innerHTML = `<div class="nmw-head"><strong>小说续写工坊·移动版</strong><button id="nmw-close" class="menu_button">关闭</button></div>
<p>目录链接会自动读取前6章。可增加章节数或读取全书；每章会调用当前模型建立并校核档案，产生相应模型用量。建档时请保持酒馆标签在前台，后台休眠可能暂停任务。</p>
<label>小说目录 / 单章网址<input id="nmw-url" class="text_pole" type="url" placeholder="https://…"></label>
<div class="nmw-row"><label>累计读到第几章<input id="nmw-count" class="text_pole" type="number" value="6" min="1" max="15000"></label><label>联网方式<select id="nmw-mode" class="text_pole"><option value="http">酒馆内置网页接口（无需电脑）</option></select></label></div>
<label>正文 CSS 选择器（通常留空；网站提取不准时填写）<input id="nmw-selector" class="text_pole" placeholder="#chaptercontent"></label>
<div class="nmw-row"><button id="nmw-read" class="menu_button">读取 / 继续建档</button><button id="nmw-all" class="menu_button">读取全书</button><button id="nmw-cancel" class="menu_button">暂停</button></div>
<label>本地书库<select id="nmw-library" class="text_pole"></select></label>
<div class="nmw-row"><label>叙述人称<select id="nmw-pov" class="text_pole"><option value="third">第三人称</option><option value="first">第一人称（我）</option></select></label><label>代入角色<input id="nmw-role" class="text_pole" placeholder="例如：孙悟空"></label></div>
<label>自定义起点 / 场景<textarea id="nmw-scene" class="text_pole" rows="3" placeholder="例如：拜师前夜，独自听见山门外有人敲门"></textarea></label>
<div class="nmw-row"><button id="nmw-save" class="menu_button">应用体验设置</button><button id="nmw-scenes" class="menu_button">生成可选续写场景</button><button id="nmw-export" class="menu_button">导出故事档案</button></div>
<pre id="nmw-status">先选择“小说续写工坊·移动版”角色，再输入网址。第一次建议读6章检查正文与档案质量。</pre>`;
    document.body.append(panel);
    const button = document.createElement('button'); button.id = 'nmw-toggle'; button.textContent = '手机联网'; button.className = 'menu_button'; document.body.append(button);
    button.onclick = guarded(async () => { panel.hidden = !panel.hidden; if (!panel.hidden) { await library(); const s = settings(); panel.querySelector('#nmw-pov').value = s.pov || 'third'; panel.querySelector('#nmw-role').value = s.role || ''; panel.querySelector('#nmw-scene').value = s.scene || ''; if (activeBook) panel.querySelector('#nmw-url').value = activeBook.url; } });
    panel.querySelector('#nmw-close').onclick = () => panel.hidden = true;
    const options = () => ({ mode: panel.querySelector('#nmw-mode').value, selector: panel.querySelector('#nmw-selector').value });
    panel.querySelector('#nmw-read').onclick = guarded(() => importNovel(panel.querySelector('#nmw-url').value.trim(), panel.querySelector('#nmw-count').value, options()));
    panel.querySelector('#nmw-all').onclick = guarded(async () => { if (confirm('将逐章读取全书并调用当前模型建档。长篇小说可能耗时较长并产生较多模型用量；可随时暂停、以后继续。是否开始？')) await importNovel(panel.querySelector('#nmw-url').value.trim(), 'all', options()); });
    panel.querySelector('#nmw-cancel').onclick = () => { cancelled = true; status('将在当前网络/模型请求完成后暂停，已完成的档案会保留。'); };
    panel.querySelector('#nmw-library').onchange = guarded(async () => { checkChat(); if (!isCard()) throw new Error('请先选择工坊角色'); if (busy) throw new Error('请先暂停读取'); const id = panel.querySelector('#nmw-library').value; if (!id) return; activeBook = await api(`/book/${id}`); await updateSettings({ bookId: id }); panel.querySelector('#nmw-url').value = activeBook.url; refreshPrompt(); status(`已载入《${activeBook.title}》，档案覆盖前${activeBook.bibleThrough}章。`); });
    panel.querySelector('#nmw-save').onclick = guarded(async () => { checkChat(); await updateSettings({ pov: panel.querySelector('#nmw-pov').value, role: panel.querySelector('#nmw-role').value.trim(), scene: panel.querySelector('#nmw-scene').value.trim() }); refreshPrompt(); status('体验设置已应用到当前聊天。'); });
    panel.querySelector('#nmw-scenes').onclick = guarded(offerScenes);
    panel.querySelector('#nmw-export').onclick = guarded(async () => { if (!activeBook) throw new Error('尚未载入小说'); const a = document.createElement('a'); const u = URL.createObjectURL(new Blob([JSON.stringify(activeBook, null, 2)], { type: 'application/json' })); a.href = u; a.download = `${activeBook.title.replace(/[\\/:*?"<>|]/g, '_')}-故事档案.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); });
    globalThis.novelWorkshopMobileIntercept = intercept;
    ctx().eventSource.on(ctx().eventTypes.CHAT_CHANGED, restore);
    globalThis.NovelWorkshopMobile = { importNovel, offerScenes, api, restore, getBook: () => activeBook, getSettings: settings, setSettings: async patch => { await updateSettings(patch); refreshPrompt(); }, isBusy: () => busy };
    setupMobilePanel();
    restore();
}
