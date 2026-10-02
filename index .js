/* 缓存工具 v0.3.0（前缀对比 + 命中率 + 缓存标记）
 * 1) 每次发送请求时，和最近几次请求比较开头，找出第一个不同的位置，
 *    告诉你缓存会从哪里断掉，以及常见原因。
 * 2) 读取每次回复里的 usage，显示缓存读取/写入/未缓存的 token 数和命中率。
 * 3) 可选：给发往中转站/OpenRouter 的请求自动加缓存标记（cache_control），默认关闭。
 * 只在浏览器内存里处理，不保存、不上传提示词和回复内容。
 */
(function () {
    'use strict';

    const EXT = 'cacheDiff';
    const KEEP = 5;          // 记住最近几次请求
    const MIN_COMMON = 200;  // 共同开头少于这个字符数，视为另一类请求，不做判断
    const history = [];
    let lastReport = '还没有记录。正常发送一条消息，再发一条后，点"刷新"查看。';
    const rows = [];           // 命中率记录
    let pendingDiff = null;    // 当前这次请求的前缀对比结果
    let lastUsageSnips = '';   // usage 原始片段，排查用
    let markStatus = '缓存标记：未开启';

    const getCtx = () => SillyTavern.getContext();

    function settings() {
        const c = getCtx();
        const def = { toast: true, writeMult: 1.25, mark: false, depth: 1, ttl: '5m', sysBp: true };
        if (!c.extensionSettings[EXT]) c.extensionSettings[EXT] = {};
        const st = c.extensionSettings[EXT];
        for (const k of Object.keys(def)) if (st[k] === undefined) st[k] = def[k];
        return st;
    }

    function bodyOf(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map(p => (p && p.type === 'text') ? p.text : `[${p && p.type}]`)
                .join('\n');
        }
        return String(content === undefined || content === null ? '' : content);
    }

    // 把消息数组整理成 { roles, texts }，texts 里带上角色和名字
    function toReq(messages) {
        const roles = [];
        const texts = [];
        for (const m of messages) {
            const role = m.role || 'user';
            roles.push(role);
            texts.push(`[${role}${m.name ? ':' + m.name : ''}] ${bodyOf(m.content)}`);
        }
        return { roles, texts };
    }

    // 找第一个不同的位置。index=-1 表示完全相同
    function firstDiff(a, b) {
        const n = Math.min(a.texts.length, b.texts.length);
        let common = 0;
        for (let i = 0; i < n; i++) {
            const x = a.texts[i];
            const y = b.texts[i];
            if (x === y) { common += x.length; continue; }
            let k = 0;
            const m = Math.min(x.length, y.length);
            while (k < m && x[k] === y[k]) k++;
            return { index: i, offset: k, common: common + k };
        }
        if (a.texts.length === b.texts.length) return { index: -1, offset: 0, common };
        return { index: n, offset: 0, common };
    }

    // 从最近往前找，取最近一次"同类"请求（开头重合够多）来比；
    // 都不够像时，退而取重合最多的那一次，报告里会标为"另一类请求"
    function pickBest(cur) {
        let best = null;
        for (let i = history.length - 1; i >= 0; i--) {
            const d = firstDiff(history[i], cur);
            if (d.common >= MIN_COMMON) return { prev: history[i], diff: d };
            if (!best || d.common > best.diff.common) best = { prev: history[i], diff: d };
        }
        return best;
    }

    // 请求末尾连续的 system 消息条数（动笔前的思考、可开关条目等）
    function tailSystemCount(req) {
        let n = 0;
        for (let i = req.roles.length - 1; i >= 0 && req.roles[i] === 'system'; i--) n++;
        return n;
    }

    function region(req, i) {
        const role = req.roles[i];
        const firstHist = req.roles.findIndex(r => r !== 'system');
        if (role === 'system') {
            if (firstHist === -1 || i < firstHist) {
                return {
                    name: '前置设定区（预设规则、角色卡、世界书等）',
                    hint: '常见原因：触发式世界书条目忽有忽无、{{time}} {{random}} 之类的动态宏、刚改过预设或角色卡。',
                };
            }
            return {
                name: '夹在聊天历史中间的系统注入',
                hint: '常见原因：世界书 @D 注入深度偏大、作者备注、状态栏或向量检索类插件。',
            };
        }
        return {
            name: '聊天历史',
            hint: '常见原因：编辑或删除过更早的消息、上下文满了开始丢旧消息、正则只处理了部分旧消息、总结或隐藏刚更新。',
        };
    }

    function snippet(s, k) {
        if (s === undefined) return '(无这一条)';
        const a = Math.max(0, k - 40);
        const b = k + 100;
        return (a > 0 ? '…' : '') + s.slice(a, b).replace(/\n/g, '⏎') + (s.length > b ? '…' : '');
    }

    function buildReport(prev, cur, d) {
        const tail = tailSystemCount(prev);
        const stableEnd = prev.texts.length - tail; // 上一次请求里聊天历史结束的位置
        const prevTotal = prev.texts.reduce((n, t) => n + t.length, 0);
        const pct = prevTotal ? Math.round((d.common / prevTotal) * 100) : 0;

        let level;
        if (d.common < MIN_COMMON) level = 'other';
        else if (d.index === -1) level = 'same';
        else if (d.index >= stableEnd) level = 'ok';
        else level = 'break';

        const lines = [];
        lines.push(`时间 ${new Date().toLocaleTimeString()}　本次 ${cur.texts.length} 条，对比的上次 ${prev.texts.length} 条`);

        if (level === 'same') {
            lines.push('✅ 与上一次请求完全相同（重新生成或滑动），缓存应整段命中。');
        } else if (level === 'ok') {
            lines.push('✅ 正常：聊天历史原样保留，只有末尾变化（新消息和末尾提示）。');
            lines.push(`上一次请求开头约 ${pct}% 的内容在这次原样保留。`);
        } else if (level === 'other') {
            lines.push('ℹ 与最近的请求几乎没有共同开头：可能是另一类请求（总结、翻译等），或预设/系统部分刚被修改过。这次不做判断。');
        } else {
            const src = d.index < cur.texts.length ? cur : prev;
            const r = region(src, d.index);
            lines.push(`⚠ 缓存断点：从第 ${d.index + 1} 条起与上一次不同，这条之后的缓存全部失效。`);
            lines.push(`位置：${r.name}`);
            lines.push(`上一次请求开头约 ${pct}% 的内容在这次原样保留，之后的都要重新计算。`);
            lines.push(r.hint);
            lines.push('');
            lines.push('旧：' + snippet(prev.texts[d.index], d.offset));
            lines.push('新：' + snippet(cur.texts[d.index], d.offset));
        }
        return { text: lines.join('\n'), level };
    }

    function onMessages(messages) {
        const cur = toReq(messages);
        if (history.length) {
            const best = pickBest(cur);
            const rep = buildReport(best.prev, cur, best.diff);
            lastReport = rep.text;
            pendingDiff = { level: rep.level, index: best.diff.index };
            if (rep.level === 'break' && settings().toast && window.toastr) {
                window.toastr.warning('缓存前缀有变化，详情见扩展面板"缓存前缀对比"', '缓存断点', { timeOut: 6000 });
            }
        } else {
            lastReport = '已记录第一次请求，下一次发送后开始对比。';
            pendingDiff = null;
        }
        history.push(cur);
        if (history.length > KEEP) history.shift();
        render();
    }

    // ---------- 命中率 ----------
    const fmt = (n) => (n === undefined || n === null) ? '-' : Number(n).toLocaleString('en-US');

    // 取文本里某个数字字段出现过的最大值（流式里同一个字段会出现多次）
    function grab(text, key) {
        const re = new RegExp('"' + key + '"\\s*:\\s*(\\d+)', 'g');
        let m;
        let best;
        while ((m = re.exec(text)) !== null) {
            const v = Number(m[1]);
            if (best === undefined || v > best) best = v;
        }
        return best;
    }

    function parseUsage(text) {
        const inTok = grab(text, 'input_tokens');
        const prompt = grab(text, 'prompt_tokens');
        const readA = grab(text, 'cache_read_input_tokens');
        const readO = grab(text, 'cached_tokens');
        const writeRaw = grab(text, 'cache_creation_input_tokens');
        const w5 = grab(text, 'ephemeral_5m_input_tokens');
        const w1 = grab(text, 'ephemeral_1h_input_tokens');
        let out = grab(text, 'output_tokens');
        if (out === undefined) out = grab(text, 'completion_tokens');
        if ([inTok, prompt, readA, readO, writeRaw].every(v => v === undefined)) return null;

        const read = readA !== undefined ? readA : (readO || 0);
        const write = writeRaw || 0;
        const p = prompt || 0;
        let total;
        let uncached;
        if (inTok !== undefined) {            // Anthropic 口径：input_tokens 只含未缓存部分
            uncached = inTok;
            total = inTok + read + write;
        } else if (p >= read + write) {       // OpenAI 口径：prompt_tokens 是总数
            total = p;
            uncached = p - read - write;
        } else {                              // prompt_tokens 只含未缓存部分
            uncached = p;
            total = p + read + write;
        }
        return { total, uncached, read, write, out, w5, w1 };
    }

    // 估算输入成本（以不用缓存时的总输入为 1）
    function costOf(u) {
        const wm = Number(settings().writeMult) || 1.25;
        const split = u.w5 !== undefined || u.w1 !== undefined;
        const writeCost = split ? (u.w5 || 0) * 1.25 + (u.w1 || 0) * 2 : u.write * wm;
        return u.uncached + writeCost + u.read * 0.1;
    }

    function usageText() {
        if (!rows.length) return '还没有捕获到请求。发一条消息、等回复完，再点"刷新"。';
        const ok = rows.filter(r => r.u);
        const lines = [];
        if (ok.length) {
            const T = ok.reduce((a, r) => ({
                total: a.total + r.u.total,
                read: a.read + r.u.read,
                cost: a.cost + costOf(r.u),
            }), { total: 0, read: 0, cost: 0 });
            const hit = T.total ? Math.round((T.read / T.total) * 100) : 0;
            const ratio = T.total ? Math.round((T.cost / T.total) * 100) : 0;
            lines.push(`共 ${ok.length} 次：整体命中率 ${hit}%；估算输入成本约为不用缓存时的 ${ratio}%（省 ${100 - ratio}%）`);
            lines.push('（只算输入；按官方倍率估算：读取 0.1 倍，写入 1.25 倍或 2 倍。中转站实际计费可能不同。）');
        }
        const miss = rows.length - ok.length;
        if (miss) {
            lines.push(`有 ${miss} 次没拿到 usage 数据：可能是中转站没有返回，或酒馆没转发。点下面"复制usage原始片段"可以排查。`);
        }
        lines.push('');
        for (const r of rows.slice(-15).reverse()) {
            if (!r.u) { lines.push(`${r.time}  无usage数据`); continue; }
            const u = r.u;
            const pct = u.total ? Math.round((u.read / u.total) * 100) : 0;
            const flag = (r.diff && r.diff.level === 'break') ? `  ⚠前缀在第${r.diff.index + 1}条变了` : '';
            lines.push(`${r.time}  命中${pct}%  总${fmt(u.total)} 读${fmt(u.read)} 写${fmt(u.write)} 未缓存${fmt(u.uncached)} 出${fmt(u.out)}${flag}`);
        }
        return lines.join('\n');
    }

    async function readUsage(res, diff) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let head = '';
        let tail = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const s = dec.decode(value, { stream: true });
            if (head.length < 20000) head += s;
            tail = (tail + s).slice(-20000);
        }
        // 只保留开头和结尾，usage 通常在这两处
        const text = (head.length >= 20000 && tail.length >= 20000) ? head + '\n' + tail : head;
        const u = parseUsage(text);
        const snips = (text.match(/"usage"\s*:\s*\{.{0,500}/g) || []).slice(0, 4).join('\n');
        if (snips) lastUsageSnips = snips;
        rows.push({ time: new Date().toLocaleTimeString(), u, diff });
        if (rows.length > 100) rows.shift();
        render();
    }

    function hookFetch() {
        if (window.__cdFetchHooked) return;
        window.__cdFetchHooked = true;
        const orig = window.fetch.bind(window);
        window.fetch = async function (input, init) {
            const diff = pendingDiff;   // 发出请求时对应的前缀对比结果
            const res = await orig(input, init);
            try {
                const url = typeof input === 'string' ? input : ((input && input.url) || '');
                if (url.includes('/api/backends/chat-completions/generate') && res.ok && res.body) {
                    readUsage(res.clone(), diff).catch(e => console.error('[cacheDiff] 读取 usage 失败', e));
                }
            } catch (e) { console.error('[cacheDiff]', e); }
            return res;
        };
    }

    // ---------- 缓存标记（给中转站 / OpenRouter 用） ----------
    function hasMark(m) {
        return Array.isArray(m.content) && m.content.some(p => p && p.cache_control);
    }

    // 给一条消息的最后一段文字加上 cache_control
    function markMsg(m, ttl) {
        const cc = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
        if (typeof m.content === 'string') {
            if (!m.content.trim()) return false;
            m.content = [{ type: 'text', text: m.content, cache_control: cc }];
            return true;
        }
        if (Array.isArray(m.content)) {
            for (let i = m.content.length - 1; i >= 0; i--) {
                const p = m.content[i];
                if (p && p.type === 'text' && p.text && p.text.trim()) { p.cache_control = cc; return true; }
            }
        }
        return false;
    }

    // 断点位置：前置设定区最后一条 + 聊天历史里倒数第 depth+1 条和再往前两条
    // （和 cachingAtDepth 的思路一样，让断点落在稳定的历史上，避开末尾每轮都变的提示）
    function applyMarks(data) {
        const st = settings();
        if (!st.mark) { markStatus = '缓存标记：未开启'; return; }
        const src = data.chat_completion_source || '(未知)';
        if (src !== 'custom' && src !== 'openrouter') {
            markStatus = `缓存标记：未应用（当前来源是 ${src}，只对"自定义/中转站"和 OpenRouter 来源生效）`;
            return;
        }
        const msgs = data.messages;
        if (msgs.some(hasMark)) { markStatus = '缓存标记：未应用（请求里已有缓存标记，不重复添加）'; return; }

        const h = [];
        msgs.forEach((m, i) => { if (m.role !== 'system') h.push(i); });
        if (!h.length) { markStatus = '缓存标记：未应用（没有聊天历史）'; return; }

        const d = Number(st.depth) || 0;
        const targets = [];
        if (st.sysBp && h[0] > 0) targets.push(h[0] - 1);
        const b = h[h.length - 1 - d - 2];
        const a = h[h.length - 1 - d];
        if (b !== undefined) targets.push(b);
        if (a !== undefined) targets.push(a);

        const done = [];
        for (const i of [...new Set(targets)]) {
            if (markMsg(msgs[i], st.ttl)) done.push(i + 1);
        }
        markStatus = done.length
            ? `缓存标记：本次已在第 ${done.join('、')} 条加标记（共 ${msgs.length} 条，来源 ${src}，有效期 ${st.ttl === '1h' ? '1 小时' : '5 分钟'}）`
            : '缓存标记：未应用（没有找到可以加标记的位置）';
    }

    function render() {
        const el = document.getElementById('cd_report');
        if (el) el.textContent = lastReport;
        const ms = document.getElementById('cd_markstatus');
        if (ms) ms.textContent = markStatus;
        const u = document.getElementById('cd_usage');
        if (u) u.textContent = usageText();
    }

    function copyText(t) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                return navigator.clipboard.writeText(t);
            }
        } catch (_) { /* 退回到下面的办法 */ }
        const ta = document.createElement('textarea');
        ta.value = t;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }

    function addPanel() {
        const html = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>缓存前缀对比</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="cd_toast"><span>发现缓存断点时弹提示</span></label>
    <div class="flex-container">
      <div id="cd_refresh" class="menu_button">刷新</div>
      <div id="cd_copy" class="menu_button">复制报告</div>
      <div id="cd_clear" class="menu_button">清空记录</div>
    </div>
    <pre id="cd_report" style="white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow:auto;font-size:0.85em;"></pre>
    <div style="margin-top:8px;"><b>缓存标记（给中转站用，默认关闭）</b></div>
    <label class="checkbox_label"><input type="checkbox" id="cd_mark"><span>自动给请求加缓存标记</span></label>
    <div class="flex-container">
      <span>断点深度</span>
      <select id="cd_depth" class="text_pole">
        <option value="0">0</option>
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
      <span>有效期</span>
      <select id="cd_ttl" class="text_pole">
        <option value="5m">5 分钟</option>
        <option value="1h">1 小时</option>
      </select>
    </div>
    <label class="checkbox_label"><input type="checkbox" id="cd_sysbp"><span>同时给前置设定区加断点</span></label>
    <pre id="cd_markstatus" style="white-space:pre-wrap;word-break:break-all;font-size:0.85em;"></pre>
    <div style="margin-top:8px;"><b>命中率</b></div>
    <div class="flex-container">
      <span>写入倍率（回复里没分 5 分钟/1 小时时用）</span>
      <select id="cd_wmult" class="text_pole">
        <option value="1.25">1.25（5 分钟）</option>
        <option value="2">2（1 小时）</option>
      </select>
    </div>
    <pre id="cd_usage" style="white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow:auto;font-size:0.85em;"></pre>
    <div class="flex-container">
      <div id="cd_copy_usage" class="menu_button">复制usage原始片段</div>
    </div>
  </div>
</div>`;
        $('#extensions_settings2').append(html);
        $('#cd_toast').prop('checked', !!settings().toast).on('change', function () {
            settings().toast = $(this).prop('checked');
            getCtx().saveSettingsDebounced();
        });
        $('#cd_refresh').on('click', render);
        $('#cd_copy').on('click', () => {
            copyText(lastReport);
            if (window.toastr) window.toastr.info('已复制');
        });
        $('#cd_clear').on('click', () => {
            history.length = 0;
            rows.length = 0;
            lastReport = '已清空，下一次发送后重新开始记录。';
            render();
        });
        $('#cd_mark').prop('checked', !!settings().mark).on('change', function () {
            settings().mark = $(this).prop('checked');
            getCtx().saveSettingsDebounced();
            if (!settings().mark) markStatus = '缓存标记：未开启';
            render();
        });
        $('#cd_sysbp').prop('checked', !!settings().sysBp).on('change', function () {
            settings().sysBp = $(this).prop('checked');
            getCtx().saveSettingsDebounced();
        });
        $('#cd_depth').val(String(settings().depth)).on('change', function () {
            settings().depth = Number($(this).val());
            getCtx().saveSettingsDebounced();
        });
        $('#cd_ttl').val(settings().ttl).on('change', function () {
            settings().ttl = $(this).val();
            getCtx().saveSettingsDebounced();
        });
        $('#cd_wmult').val(String(settings().writeMult || 1.25)).on('change', function () {
            settings().writeMult = Number($(this).val());
            getCtx().saveSettingsDebounced();
            render();
        });
        $('#cd_copy_usage').on('click', () => {
            copyText(lastUsageSnips || '还没有捕获到 usage 片段');
            if (window.toastr) window.toastr.info('已复制');
        });
        render();
    }

    function hook() {
        const c = getCtx();
        const et = c.eventTypes || c.event_types || {};
        const safe = (fn) => { try { fn(); } catch (e) { console.error('[cacheDiff]', e); } };

        if (et.CHAT_COMPLETION_SETTINGS_READY) {
            // 最接近真正发出去的内容
            c.eventSource.on(et.CHAT_COMPLETION_SETTINGS_READY, (data) => safe(() => {
                if (data && Array.isArray(data.messages)) {
                    onMessages(data.messages);   // 先对比（此时还没加标记）
                    applyMarks(data);            // 再按需加缓存标记
                    render();
                }
            }));
        } else if (et.CHAT_COMPLETION_PROMPT_READY) {
            c.eventSource.on(et.CHAT_COMPLETION_PROMPT_READY, (data) => safe(() => {
                if (data && !data.dryRun && Array.isArray(data.chat)) onMessages(data.chat);
            }));
        } else {
            lastReport = '这个版本的酒馆里找不到需要的事件，插件无法工作。请把酒馆版本号告诉我。';
            render();
        }
    }

    jQuery(() => {
        try {
            addPanel();
            hook();
            hookFetch();
        } catch (e) {
            console.error('[cacheDiff] 初始化失败', e);
        }
    });
})();
