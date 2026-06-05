# Dashboard Tabbed UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the monitoring-only dashboard into a full tabbed UI with Chat, Governance, History, and Config tabs — enabling users to interact with CynCo directly from the browser.

**Architecture:** Single `index.html` with vanilla JS tab switching. Chat tab sends `user.message` over the existing WebSocket. Engine emits new `stream.thinking` events for reasoning token visibility. All existing panels reorganized into Governance/History/Config tabs. TUI continues to work independently.

**Tech Stack:** HTML/CSS/JS (no framework), WebSocket (existing), Bun/TypeScript engine

---

### Task 1: Add stream.thinking event to engine

**Files:**
- Modify: `engine/bridge/protocol.ts`
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Add StreamThinkingEvent type**

In `engine/bridge/protocol.ts`, after `StreamTokenEvent` (line ~39):

```typescript
export type StreamThinkingEvent = {
  type: 'stream.thinking'
  text: string
  messageId?: string
}
```

Add to the `EngineEvent` union (after `StreamTokenEvent`):
```typescript
  | StreamThinkingEvent
```

- [ ] **Step 2: Emit stream.thinking for reasoning tokens**

In `engine/bridge/conversationLoop.ts`, find the `thinking_delta` handler (around line 1487-1489):

```typescript
// OLD:
if (delta?.type === 'thinking_delta' && delta.thinking) {
  reasoningTokenCount++
}

// NEW:
if (delta?.type === 'thinking_delta' && delta.thinking) {
  reasoningTokenCount++
  this.emit({ type: 'stream.thinking', text: delta.thinking })
}
```

- [ ] **Step 3: Commit**

```bash
git add engine/bridge/protocol.ts engine/bridge/conversationLoop.ts
git commit -m "feat: emit stream.thinking events for reasoning token visibility"
```

---

### Task 2: Add tab infrastructure to dashboard HTML

**Files:**
- Modify: `engine/dashboard/index.html`

- [ ] **Step 1: Add tab CSS**

Add after the existing CSS rules (before `</style>`):

```css
/* ── Tabs ────────────────────────────────────────────────── */
.tab-bar {
  display: flex; gap: 0; background: #1a1a2e; padding: 0 12px;
  border-bottom: 2px solid #333; margin-bottom: 12px;
}
.tab-btn {
  padding: 8px 20px; background: none; border: none; border-bottom: 2px solid transparent;
  color: #808080; font-size: 13px; font-weight: 600; cursor: pointer;
  font-family: 'Cascadia Code', 'Fira Code', monospace; margin-bottom: -2px;
}
.tab-btn:hover { color: #d4d4d4; }
.tab-btn.active { color: #4ec9b0; border-bottom-color: #4ec9b0; }
.tab-content { display: none; }
.tab-content.active { display: block; }
```

- [ ] **Step 2: Add tab bar HTML**

After the header line (`<h1>CynCo Governance Dashboard...`), add:

```html
<div class="tab-bar">
  <button class="tab-btn active" onclick="switchTab('chat')">Chat</button>
  <button class="tab-btn" onclick="switchTab('governance')">Governance</button>
  <button class="tab-btn" onclick="switchTab('history')">History</button>
  <button class="tab-btn" onclick="switchTab('config')">Config</button>
</div>
```

- [ ] **Step 3: Wrap existing content in governance tab**

Wrap ALL existing panels (from Connection Status through Prediction Tracker) in:

```html
<div id="tab-governance" class="tab-content">
  <!-- ALL existing dashboard panels here -->
</div>
```

Wrap the Parameter Controls + Advanced section in:

```html
<div id="tab-config" class="tab-content">
  <!-- Engine Config + System Controls + Advanced -->
</div>
```

Wrap the Session History section in:

```html
<div id="tab-history" class="tab-content">
  <!-- Session History panel -->
</div>
```

Add empty chat tab:

```html
<div id="tab-chat" class="tab-content active">
  <div id="chatArea" style="padding:0 12px;">Loading chat...</div>
</div>
```

- [ ] **Step 4: Add tab switching JS**

```javascript
function switchTab(name) {
  var tabs = document.querySelectorAll('.tab-content');
  var btns = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  var el = document.getElementById('tab-' + name);
  if (el) el.classList.add('active');
  // Find the button
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].textContent.trim().toLowerCase() === name) btns[i].classList.add('active');
  }
}
```

- [ ] **Step 5: Verify tabs switch — take screenshot**

Run engine, open dashboard, click between tabs. Each should show its content.

- [ ] **Step 6: Commit**

```bash
git add engine/dashboard/index.html
git commit -m "feat: add tab infrastructure — Chat, Governance, History, Config"
```

---

### Task 3: Build Chat tab UI

**Files:**
- Modify: `engine/dashboard/index.html`

- [ ] **Step 1: Add chat CSS**

```css
/* ── Chat ────────────────────────────────────────────────── */
.chat-container { display:flex; flex-direction:column; height:calc(100vh - 80px); }
.chat-header { display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid #333; }
.chat-messages { flex:1; overflow-y:auto; padding:8px 0; }
.chat-input-area { border-top:1px solid #333; padding:8px 0; display:flex; gap:8px; }
.chat-input { flex:1; background:#1e1e2e; color:#d4d4d4; border:1px solid #444; border-radius:6px;
  padding:8px 12px; font-size:13px; font-family:'Cascadia Code','Fira Code',monospace; outline:none; }
.chat-input:focus { border-color:#4ec9b0; }
.chat-send { background:#264f78; color:#d4d4d4; border:none; padding:8px 16px; border-radius:6px;
  cursor:pointer; font-size:13px; font-weight:600; }
.chat-send:hover { background:#2d5a8a; }
.chat-msg { margin-bottom:8px; }
.chat-msg-user { color:#808080; }
.chat-msg-user span { color:#4ec9b0; font-weight:600; }
.chat-msg-assistant { color:#d4d4d4; }
.chat-thinking { color:#555; font-style:italic; font-size:12px; border-left:2px solid #333;
  padding-left:8px; margin:4px 0; cursor:pointer; max-height:20px; overflow:hidden; transition:max-height 0.3s; }
.chat-thinking.expanded { max-height:500px; }
.chat-tool { background:#252535; border-radius:4px; padding:6px 10px; margin:2px 0;
  display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; }
.chat-tool-detail { display:none; background:#1a1a2e; border:1px solid #333; border-radius:4px;
  padding:8px; margin:2px 0 2px 20px; font-size:11px; font-family:monospace; max-height:200px; overflow-y:auto; }
.chat-tool-detail.visible { display:block; }
.cwd-input { background:#1e1e2e; color:#808080; border:1px solid #333; border-radius:4px;
  padding:4px 8px; font-size:11px; width:300px; font-family:'Cascadia Code',monospace; }
```

- [ ] **Step 2: Build chat HTML**

Replace `<div id="chatArea">Loading chat...</div>` with:

```html
<div class="chat-container">
  <div class="chat-header">
    <label style="color:#808080;font-size:11px;">CWD:</label>
    <input class="cwd-input" id="chatCwd" value="C:/Users/civer/civkings" placeholder="Working directory">
  </div>
  <div class="chat-messages" id="chatMessages"></div>
  <div class="chat-input-area">
    <input class="chat-input" id="chatInput" placeholder="Type a message... (/plan, /tdd, /debug for workflows)"
           onkeydown="if(event.key==='Enter')sendChatMessage()">
    <button class="chat-send" onclick="sendChatMessage()">Send</button>
  </div>
</div>
```

- [ ] **Step 3: Add chat JS**

```javascript
var chatState = { messages: [], currentThinking: '', currentTools: [] };

function sendChatMessage() {
  var input = document.getElementById('chatInput');
  var cwd = document.getElementById('chatCwd').value.trim();
  var text = input.value.trim();
  if (!text) return;
  input.value = '';

  // Handle slash commands
  if (text.startsWith('/')) {
    var parts = text.split(' ');
    var cmd = parts[0];
    var args = parts.slice(1).join(' ');
    if (['plan','tdd','debug','cancel','brainstorm','critique','review','research'].some(function(c) { return cmd === '/' + c; })) {
      sendWS({ type: 'command', command: cmd, args: args });
      appendChatMessage('system', 'Sent command: ' + cmd + (args ? ' ' + args : ''));
      return;
    }
  }

  sendWS({ type: 'user.message', text: text, cwd: cwd });
  appendChatMessage('user', text);
}

function sendWS(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function appendChatMessage(role, text) {
  var el = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'chat-msg chat-msg-' + role;
  if (role === 'user') {
    div.innerHTML = '<span>you</span> ' + escHtml(text);
  } else if (role === 'system') {
    div.style.color = '#808080';
    div.style.fontStyle = 'italic';
    div.textContent = text;
  } else {
    div.textContent = text;
  }
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function appendToolCall(toolName, target, status, latency) {
  var el = document.getElementById('chatMessages');
  var id = 'tool-' + Date.now();
  var icon = status === 'success' ? '\u2713' : status === 'error' ? '\u2717' : '\u25cc';
  var iconColor = status === 'success' ? '#4ec9b0' : status === 'error' ? '#f44747' : '#dcdcaa';
  var toolColor = {'Read':'#569cd6','Edit':'#dcdcaa','Write':'#dcdcaa','Bash':'#ce9178','Grep':'#569cd6','Glob':'#569cd6','Git':'#ce9178'}[toolName] || '#808080';
  var lat = latency ? latency + 'ms' : '';

  var row = document.createElement('div');
  row.className = 'chat-tool';
  row.setAttribute('data-id', id);
  row.innerHTML = '<span style="color:' + iconColor + '">' + icon + '</span>' +
    '<span style="color:' + toolColor + ';font-weight:600">' + escHtml(toolName) + '</span>' +
    '<span style="color:#808080;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(target) + '</span>' +
    '<span style="color:#808080;font-size:10px">' + lat + '</span>' +
    '<span style="color:#555">\u25bc</span>';
  row.onclick = function() {
    var detail = document.getElementById(id + '-detail');
    if (detail) detail.classList.toggle('visible');
  };
  el.appendChild(row);

  var detail = document.createElement('div');
  detail.className = 'chat-tool-detail';
  detail.id = id + '-detail';
  el.appendChild(detail);

  el.scrollTop = el.scrollHeight;
  return id;
}

function updateToolDetail(id, output) {
  var detail = document.getElementById(id + '-detail');
  if (detail) detail.textContent = output.slice(0, 2000);
}

function appendThinking(text) {
  var el = document.getElementById('chatMessages');
  var existing = el.querySelector('.chat-thinking:last-child');
  if (existing && !existing.dataset.closed) {
    existing.textContent += text;
  } else {
    var div = document.createElement('div');
    div.className = 'chat-thinking';
    div.textContent = text;
    div.onclick = function() { this.classList.toggle('expanded'); };
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function closeThinking() {
  var el = document.getElementById('chatMessages');
  var all = el.querySelectorAll('.chat-thinking');
  for (var i = 0; i < all.length; i++) all[i].dataset.closed = 'true';
}
```

- [ ] **Step 4: Commit**

```bash
git add engine/dashboard/index.html
git commit -m "feat: Chat tab UI with message input, tool display, thinking visibility"
```

---

### Task 4: Wire chat events to the event handler

**Files:**
- Modify: `engine/dashboard/index.html`

- [ ] **Step 1: Add chat event handlers to handleEvent switch**

In the `handleEvent` function's switch statement, add cases:

```javascript
case 'stream.token':
  if (event.text) appendChatMessage('assistant-stream', event.text);
  break;

case 'stream.thinking':
  if (event.text) appendThinking(event.text);
  break;

case 'tool.start': {
  closeThinking();
  var target = summarizeInput(event.toolName, event.input);
  var toolId = appendToolCall(event.toolName, target, 'running', null);
  // Store toolId for matching with tool.complete
  if (!chatState.activeTools) chatState.activeTools = {};
  chatState.activeTools[event.toolId || event.toolName] = { chatId: toolId, start: Date.now() };
  break;
}

case 'tool.complete': {
  var active = chatState.activeTools && chatState.activeTools[event.toolId || event.toolName];
  if (active) {
    var lat = Date.now() - active.start;
    // Update the tool row with final status
    var row = document.querySelector('[data-id="' + active.chatId + '"]');
    if (row) {
      var iconEl = row.children[0];
      iconEl.textContent = event.isError ? '\u2717' : '\u2713';
      iconEl.style.color = event.isError ? '#f44747' : '#4ec9b0';
      var latEl = row.children[3];
      latEl.textContent = lat + 'ms';
    }
    updateToolDetail(active.chatId, event.output || '');
    delete chatState.activeTools[event.toolId || event.toolName];
  }
  break;
}

case 'message.complete':
  closeThinking();
  break;
```

Note: `stream.token` needs special handling — assistant text arrives as streaming tokens. Add a streaming text accumulator:

```javascript
// Modify the stream.token case:
case 'stream.token': {
  if (!event.text) break;
  var msgs = document.getElementById('chatMessages');
  var lastEl = msgs.lastElementChild;
  if (lastEl && lastEl.classList.contains('chat-msg-assistant')) {
    lastEl.textContent += event.text;
  } else {
    closeThinking();
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg-assistant';
    div.textContent = event.text;
    msgs.appendChild(div);
  }
  msgs.scrollTop = msgs.scrollHeight;
  break;
}
```

- [ ] **Step 2: Ensure WebSocket reference is accessible**

The existing WebSocket connection is stored in a variable (find it — likely `ws` or `socket`). Verify `sendWS` can access it. If the variable is scoped inside an init function, move it to module scope.

- [ ] **Step 3: Commit**

```bash
git add engine/dashboard/index.html
git commit -m "feat: wire chat events — streaming text, thinking, tool start/complete"
```

---

### Task 5: Add session transcript endpoint for History tab

**Files:**
- Modify: `engine/dashboard/server.ts`

- [ ] **Step 1: Add transcript endpoint**

In the GET routes switch, add before the `default:` case:

```typescript
// Handle /api/sessions/:id/transcript
if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/transcript')) {
  const sid = pathname.replace('/api/sessions/', '').replace('/transcript', '')
  return this.getSessionTranscript(sid)
}
```

Add the method:

```typescript
private getSessionTranscript(sessionId: string): Response {
  try {
    const sessionDir = join(homedir(), '.cynco', 'sessions')
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`)
    if (!existsSync(sessionFile)) return jsonResponse([])
    const lines = readFileSync(sessionFile, 'utf-8').trim().split('\n')
    const entries = lines.slice(-500).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    return jsonResponse(entries)
  } catch {
    return jsonResponse([])
  }
}
```

- [ ] **Step 2: Add transcript viewer to History tab**

In the History tab HTML, add after the chart:

```html
<div id="transcriptViewer" style="margin-top:12px;max-height:400px;overflow-y:auto;font-size:11px;background:#1a1a2e;border-radius:4px;padding:8px;">
  <div style="color:#808080">Select a session and click Load to view transcript</div>
</div>
```

Add JS to load transcript when session is selected:

```javascript
function loadSessionTranscript() {
  var sid = document.getElementById('sessionSelect').value;
  if (!sid) return;
  fetch('/api/sessions/' + sid + '/transcript').then(function(r) { return r.json(); }).then(function(entries) {
    var el = document.getElementById('transcriptViewer');
    if (!entries.length) { el.innerHTML = '<div style="color:#808080">No transcript data</div>'; return; }
    var html = '';
    entries.forEach(function(e) {
      if (e.role === 'user') html += '<div style="color:#4ec9b0;margin-bottom:4px"><b>user:</b> ' + escHtml((e.content?.[0]?.text || '').slice(0, 200)) + '</div>';
      else if (e.role === 'assistant') html += '<div style="color:#d4d4d4;margin-bottom:4px"><b>assistant:</b> ' + escHtml((e.content?.[0]?.text || '').slice(0, 200)) + '</div>';
      else if (e.type === 'compaction') html += '<div style="color:#808080;margin-bottom:4px"><i>[context compacted]</i></div>';
    });
    el.innerHTML = html;
  });
}
```

Wire it to the Load button — update `loadSessionHistory` to also call `loadSessionTranscript`:

```javascript
// At end of loadSessionHistory(), add:
loadSessionTranscript();
```

- [ ] **Step 3: Commit**

```bash
git add engine/dashboard/server.ts engine/dashboard/index.html
git commit -m "feat: session transcript viewer in History tab"
```

---

### Task 6: Integration test — full tabbed dashboard

**Files:**
- No new files — manual verification

- [ ] **Step 1: Start engine**

```bash
LOCALCODE_PROVIDER=llama-cpp LOCALCODE_MODEL=qwen3.6:27b \
  LOCALCODE_MODEL_PATH=~/.cynco/models/qwen3.6-mtp/Qwen3.6-27B-Q6_K.gguf \
  LOCALCODE_SPEC_TYPE=draft-mtp LOCALCODE_SPEC_DRAFT_N=3 \
  LOCALCODE_APPROVE_ALL=true LOCALCODE_CONTEXT_LENGTH=65536 \
  bun engine/main.ts
```

- [ ] **Step 2: Open dashboard and test Chat tab**

1. Open `http://localhost:9161`
2. Type a message in the chat input, hit Enter
3. Verify: user message appears, thinking tokens show (muted italic), tool calls appear as collapsed rows, model text streams in
4. Click a tool call row — verify detail panel expands with input/output

- [ ] **Step 3: Test tab switching**

Click Governance → verify all existing panels render correctly
Click History → verify session dropdown and chart work
Click Config → verify sliders and toggles work
Click Chat → verify chat state is preserved

- [ ] **Step 4: Test slash commands**

Type `/plan` in chat input, hit Enter
Verify workflow status event appears

- [ ] **Step 5: Take screenshots of all 4 tabs**

Use Playwright to screenshot each tab for verification.

- [ ] **Step 6: Commit any fixes**

```bash
git add -u
git commit -m "fix: dashboard tabbed UI integration fixes"
```

---

### Task 7: Wire check — verify everything is connected

- [ ] **Step 1: Grep for all new symbols**

```bash
# Verify stream.thinking is emitted AND consumed
grep -r "stream.thinking" engine/ --include="*.ts" --include="*.html"

# Verify sendWS is defined AND called
grep -n "sendWS\|sendChatMessage" engine/dashboard/index.html

# Verify tab switching works
grep -n "switchTab\|tab-content\|tab-btn" engine/dashboard/index.html

# Verify transcript endpoint exists
grep -n "transcript" engine/dashboard/server.ts

# Verify new governance flags are called
grep -n "markNudgeInjected\|markTemperatureLowered\|setContractCreated\|trackReadPattern\|setS4ReflectionRan\|resetTurnFlags" engine/bridge/conversationLoop.ts engine/vsm/cyberneticsGovernance.ts
```

Every symbol must appear in at least 2 places (definition + usage). Flag any orphans.

- [ ] **Step 2: Run all tests**

```bash
cd engine && bun test
```

Expected: All pass, no regressions.

- [ ] **Step 3: Final commit**

```bash
git add -u
git commit -m "chore: wire check complete — all new symbols verified connected"
```
