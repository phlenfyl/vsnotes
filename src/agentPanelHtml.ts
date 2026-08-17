/**
 * agentPanelHtml.ts
 * HTML/CSS/JS for the NoteVs agent chat panel. Function-returns-HTML-string
 * pattern, same as notesListHtml()/settingsHtml()/welcomeHtml() in
 * extension.ts.
 *
 * NOTE: no literal backtick characters below (esbuild misparses them inside
 * template literals when bundling — see extension/CLAUDE.md).
 */

export function agentChatHtml(projectName: string): string {
  const safeProject = projectName.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>' +
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>' +
  '<style>' +
  'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}' +
  '.toolbar{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}' +
  '.project-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground)}' +
  '.title-row{display:flex;align-items:center;gap:8px}' +
  '.title-row .agent-title{font-size:13px;font-weight:600}' +
  '.status-pill{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--vscode-descriptionForeground);padding:3px 8px;border-radius:10px;border:1px solid var(--vscode-panel-border);cursor:default}' +
  '.status-dot{width:7px;height:7px;border-radius:50%;background:#888;flex-shrink:0}' +
  '.status-dot.up{background:#3fb950}' +
  '.status-dot.down{background:#f85149}' +
  '.status-dot.busy{background:#d29922;animation:pulse 1.4s ease-in-out infinite}' +
  '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
  '.messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}' +
  '.msg{max-width:85%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.45;word-wrap:break-word}' +
  '.msg.user{align-self:flex-end;background:var(--vscode-button-background);color:var(--vscode-button-foreground);white-space:pre-wrap}' +
  '.msg.bot{align-self:flex-start;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border)}' +
  '.msg.system{align-self:center;font-size:11px;color:var(--vscode-descriptionForeground);background:none;padding:2px;white-space:pre-wrap}' +
  '.msg.bot p{margin:0 0 6px 0}' +
  '.msg.bot p:last-child{margin-bottom:0}' +
  '.msg.bot ul,.msg.bot ol{margin:4px 0 8px 20px;padding:0}' +
  '.msg.bot li{margin:2px 0}' +
  '.msg.bot code{background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.2));padding:1px 4px;border-radius:4px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}' +
  '.msg.bot pre{background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.15));padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0}' +
  '.msg.bot pre code{background:none;padding:0}' +
  '.msg.bot table{border-collapse:collapse;margin:6px 0;font-size:12px;width:100%}' +
  '.msg.bot th,.msg.bot td{border:1px solid var(--vscode-panel-border);padding:4px 8px;text-align:left}' +
  '.msg.bot th{background:rgba(127,127,127,.1)}' +
  '.msg.bot strong{font-weight:600}' +
  '.confirm-card{align-self:flex-start;max-width:90%;padding:12px;border-radius:10px;background:rgba(251,191,36,0.10);border:1.5px solid rgba(251,191,36,0.55);display:flex;flex-direction:column;gap:8px}' +
  '.confirm-card .confirm-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#d29922;display:flex;align-items:center;gap:5px}' +
  '.confirm-card .confirm-text{font-size:13px;line-height:1.45}' +
  '.confirm-buttons{display:flex;gap:8px}' +
  '.confirm-buttons button{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}' +
  '.confirm-buttons button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}' +
  '.confirm-buttons button:hover{opacity:.85}' +
  '.thinking{align-self:flex-start;display:flex;gap:4px;padding:8px 12px}' +
  '.thinking span{width:6px;height:6px;border-radius:50%;background:var(--vscode-descriptionForeground);opacity:.5;animation:bounce 1.2s infinite}' +
  '.thinking span:nth-child(2){animation-delay:.15s}' +
  '.thinking span:nth-child(3){animation-delay:.3s}' +
  '@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}' +
  '.input-row{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0}' +
  '#msgInput{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border, var(--vscode-panel-border));border-radius:6px;padding:7px 10px;font-size:13px;font-family:var(--vscode-font-family);resize:none;max-height:160px;overflow-y:auto;line-height:1.4}' +
  '#sendBtn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;padding:0 14px;cursor:pointer}' +
  '#sendBtn:disabled{opacity:.5;cursor:default}' +
  '.empty-hint{align-self:center;color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;margin-top:20px;max-width:80%}' +
  '.toolbar-actions{display:flex;align-items:center;gap:6px}' +
  '.icon-btn{background:none;border:1px solid transparent;color:var(--vscode-foreground);border-radius:6px;padding:4px 6px;cursor:pointer;display:flex;align-items:center}' +
  '.icon-btn:hover{background:var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15));border-color:var(--vscode-panel-border)}' +
  '</style></head><body>' +
  '<div class="toolbar">' +
    '<div class="title-row"><i class="codicon codicon-comment-discussion"></i><span class="agent-title">NoteVs Agent</span></div>' +
    '<div class="toolbar-actions">' +
      '<button class="icon-btn" id="historyBtn" title="View past chats"><i class="codicon codicon-history"></i></button>' +
      '<button class="icon-btn" id="newChatBtn" title="New chat (saves this one to history)"><i class="codicon codicon-add"></i></button>' +
      '<div class="status-pill" id="statusPill"><span class="status-dot" id="rasaDot"></span><span id="statusText">Checking&hellip;</span></div>' +
    '</div>' +
  '</div>' +
  '<div class="project-name" style="padding:6px 12px 0">' + safeProject + '</div>' +
  '<div id="statusDetail" style="display:none;padding:6px 12px;font-size:11px;line-height:1.5;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border)"></div>' +
  '<div class="messages" id="messages">' +
    '<div class="empty-hint">Ask about your notes, create or edit one, or send a note to Notion, Obsidian, Todoist, or Google Tasks. Anything that leaves NoteVs or deletes a note will ask you to confirm first.</div>' +
  '</div>' +
  '<div class="input-row">' +
    '<textarea id="msgInput" rows="1" placeholder="Message the NoteVs agent&hellip;"></textarea>' +
    '<button id="sendBtn"><i class="codicon codicon-send"></i></button>' +
  '</div>' +
  '<script>' +
  '(function(){' +
  'const vscode = acquireVsCodeApi();' +
  'const messagesEl = document.getElementById("messages");' +
  'const inputEl = document.getElementById("msgInput");' +
  'const sendBtn = document.getElementById("sendBtn");' +
  'const rasaDot = document.getElementById("rasaDot");' +
  'const statusText = document.getElementById("statusText");' +
  'const newChatBtn = document.getElementById("newChatBtn");' +
  'const historyBtn = document.getElementById("historyBtn");' +
  'let thinkingEl = null;' +
  'function scrollDown(){messagesEl.scrollTop = messagesEl.scrollHeight;}' +
  'const BACKTICK = String.fromCharCode(96);' +
  'function escapeHtml(s){' +
    'return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");' +
  '}' +
  'function mdToHtml(raw){' +
    'const blocks = [];' +
    'let text = escapeHtml(raw);' +
    'const fence = new RegExp(BACKTICK + BACKTICK + BACKTICK + "([a-zA-Z0-9]*)\\\\n?([\\\\s\\\\S]*?)" + BACKTICK + BACKTICK + BACKTICK, "g");' +
    'text = text.replace(fence, function(_, lang, code){' +
      'const idx = blocks.length;' +
      'blocks.push("<pre><code>" + code.replace(/\\n$/, "") + "</code></pre>");' +
      'return "\\u0000B" + idx + "\\u0000";' +
    '});' +
    'const inlineCode = new RegExp(BACKTICK + "([^" + BACKTICK + "\\\\n]+)" + BACKTICK, "g");' +
    'text = text.replace(inlineCode, function(_, code){ return "<code>" + code + "</code>"; });' +
    'text = text.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");' +
    'text = text.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, "$1<em>$2</em>");' +
    'const lines = text.split("\\n");' +
    'let html = "";' +
    'let i = 0;' +
    'function isBullet(l){ return /^\\s*[-*]\\s+/.test(l); }' +
    'function isNumbered(l){ return /^\\s*\\d+\\.\\s+/.test(l); }' +
    'function isTableRow(l){ return /^\\s*\\|.*\\|\\s*$/.test(l); }' +
    'function splitRow(l){' +
      'const cells = l.split("|").map(function(c){ return c.trim(); });' +
      'if(cells.length && cells[0] === ""){ cells.shift(); }' +
      'if(cells.length && cells[cells.length - 1] === ""){ cells.pop(); }' +
      'return cells;' +
    '}' +
    'while(i < lines.length){' +
      'const line = lines[i];' +
      'if(isBullet(line)){' +
        'const items = [];' +
        'while(i < lines.length && isBullet(lines[i])){ items.push("<li>" + lines[i].replace(/^\\s*[-*]\\s+/, "") + "</li>"); i++; }' +
        'html += "<ul>" + items.join("") + "</ul>";' +
        'continue;' +
      '}' +
      'if(isNumbered(line)){' +
        'const items = [];' +
        'while(i < lines.length && isNumbered(lines[i])){ items.push("<li>" + lines[i].replace(/^\\s*\\d+\\.\\s+/, "") + "</li>"); i++; }' +
        'html += "<ol>" + items.join("") + "</ol>";' +
        'continue;' +
      '}' +
      'if(isTableRow(line) && i + 1 < lines.length && /^[\\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") !== -1){' +
        'const header = splitRow(line);' +
        'i += 2;' +
        'const rows = [];' +
        'while(i < lines.length && isTableRow(lines[i])){ rows.push("<tr>" + splitRow(lines[i]).map(function(c){ return "<td>" + c + "</td>"; }).join("") + "</tr>"); i++; }' +
        'html += "<table><thead><tr>" + header.map(function(c){ return "<th>" + c + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";' +
        'continue;' +
      '}' +
      'if(line.trim() === ""){ i++; continue; }' +
      'if(line.indexOf("\\u0000B") === 0){ html += line; i++; continue; }' +
      'const para = [line];' +
      'i++;' +
      'while(i < lines.length && lines[i].trim() !== "" && !isBullet(lines[i]) && !isNumbered(lines[i]) && !isTableRow(lines[i]) && lines[i].indexOf("\\u0000B") !== 0){ para.push(lines[i]); i++; }' +
      'html += "<p>" + para.join("<br>") + "</p>";' +
    '}' +
    'html = html.replace(/\\u0000B(\\d+)\\u0000/g, function(_, idx){ return blocks[Number(idx)]; });' +
    'return html;' +
  '}' +
  'function addMsg(text, cls){' +
    'const d = document.createElement("div");' +
    'd.className = "msg " + cls;' +
    'if(cls === "bot"){ d.innerHTML = mdToHtml(text); } else { d.textContent = text; }' +
    'messagesEl.appendChild(d);' +
    'scrollDown();' +
  '}' +
  'function addConfirmCard(text, buttons){' +
    'const wrap = document.createElement("div");' +
    'wrap.className = "confirm-card";' +
    'const label = document.createElement("div");' +
    'label.className = "confirm-label";' +
    'label.innerHTML = "<i class=\\"codicon codicon-warning\\"></i> Needs your confirmation";' +
    'const body = document.createElement("div");' +
    'body.className = "confirm-text";' +
    'body.textContent = text || "Proceed?";' +
    'const btnRow = document.createElement("div");' +
    'btnRow.className = "confirm-buttons";' +
    '(buttons || []).forEach(function(b, i){' +
      'const btn = document.createElement("button");' +
      'btn.textContent = b.title || "OK";' +
      'if(i === 0){btn.className = "primary";}' +
      'btn.addEventListener("click", function(){' +
        'btnRow.querySelectorAll("button").forEach(function(x){x.disabled = true;});' +
        'addMsg(b.title || "OK", "user");' +
        'vscode.postMessage({type:"buttonClick", text: b.payload});' +
      '});' +
      'btnRow.appendChild(btn);' +
    '});' +
    'wrap.appendChild(label); wrap.appendChild(body); wrap.appendChild(btnRow);' +
    'messagesEl.appendChild(wrap);' +
    'scrollDown();' +
  '}' +
  'function setThinking(on){' +
    'if(on && !thinkingEl){' +
      'thinkingEl = document.createElement("div");' +
      'thinkingEl.className = "thinking";' +
      'thinkingEl.innerHTML = "<span></span><span></span><span></span>";' +
      'messagesEl.appendChild(thinkingEl);' +
      'scrollDown();' +
    '} else if(!on && thinkingEl){' +
      'thinkingEl.remove();' +
      'thinkingEl = null;' +
    '}' +
    'sendBtn.disabled = !!on;' +
  '}' +
  'function autoGrow(){' +
    'inputEl.style.height = "auto";' +
    'inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";' +
  '}' +
  'function send(){' +
    'const text = inputEl.value.trim();' +
    'if(!text) return;' +
    'addMsg(text, "user");' +
    'inputEl.value = "";' +
    'autoGrow();' +
    'vscode.postMessage({type:"sendMessage", text: text});' +
  '}' +
  'sendBtn.addEventListener("click", send);' +
  'newChatBtn.addEventListener("click", function(){ vscode.postMessage({type:"newChat"}); });' +
  'historyBtn.addEventListener("click", function(){ vscode.postMessage({type:"viewHistory"}); });' +
  'inputEl.addEventListener("input", autoGrow);' +
  'inputEl.addEventListener("keydown", function(e){' +
    'if(e.key === "Enter" && !e.shiftKey){e.preventDefault(); send();}' +
  '});' +
  'window.addEventListener("message", function(event){' +
    'const msg = event.data;' +
    'if(msg.type === "status"){' +
      'const PHASE_LABELS = {' +
        'missing_credentials: "Add credentials in Settings",' +
        'extracting: "Setting up\\u2026",' +
        'creating_venv: "Creating environment\\u2026",' +
        'installing: "Installing (first time)\\u2026",' +
        'training: "Training (first time)\\u2026",' +
        'starting: "Starting\\u2026",' +
        'crashed: "Agent crashed \\u2014 retrying",' +
        'error: "Setup failed"' +
      '};' +
      'const statusPill = document.getElementById("statusPill");' +
      'const statusDetail = document.getElementById("statusDetail");' +
      'function showDetail(text, isError){' +
        'if(!text){statusDetail.style.display = "none"; return;}' +
        'statusDetail.textContent = text;' +
        'statusDetail.style.color = isError ? "#f85149" : "var(--vscode-descriptionForeground)";' +
        'statusDetail.style.display = "block";' +
      '}' +
      'if(msg.phase === "running" && msg.rasaUp && msg.notevsUp){' +
        'rasaDot.className = "status-dot up";' +
        'statusText.textContent = "Agent ready";' +
        'statusPill.title = "";' +
        'showDetail("");' +
      '} else if(msg.phase === "running" && !msg.notevsUp){' +
        'rasaDot.className = "status-dot down";' +
        'statusText.textContent = "NoteVs not running";' +
        'statusPill.title = "";' +
        'showDetail("");' +
      '} else if(msg.phase === "running"){' +
        'rasaDot.className = "status-dot busy";' +
        'statusText.textContent = "Starting\\u2026";' +
        'statusPill.title = msg.message || "";' +
        'showDetail(msg.message, false);' +
      '} else if(msg.phase === "error" || msg.phase === "crashed"){' +
        'rasaDot.className = "status-dot down";' +
        'statusText.textContent = PHASE_LABELS[msg.phase] || "Agent offline";' +
        'statusPill.title = msg.message || "";' +
        'showDetail(msg.message, true);' +
      '} else {' +
        'rasaDot.className = "status-dot busy";' +
        'statusText.textContent = PHASE_LABELS[msg.phase] || "Agent offline";' +
        'statusPill.title = msg.message || "";' +
        'showDetail(msg.message, false);' +
      '}' +
    '} else if(msg.type === "thinking"){' +
      'setThinking(msg.value);' +
    '} else if(msg.type === "botMessages"){' +
      '(msg.messages || []).forEach(function(m){' +
        'if(m.buttons && m.buttons.length){' +
          'addConfirmCard(m.text, m.buttons);' +
        '} else if(m.text){' +
          'addMsg(m.text, "bot");' +
        '}' +
      '});' +
    '} else if(msg.type === "clearChat"){' +
      'messagesEl.innerHTML = "";' +
      'const hint = document.createElement("div");' +
      'hint.className = "empty-hint";' +
      'hint.textContent = "New chat started \\u2014 the previous conversation was saved to .notevsagent/history/ in your project.";' +
      'messagesEl.appendChild(hint);' +
    '} else if(msg.type === "restoreTranscript"){' +
      // Reopening the panel replays the still-live session's messages:
      // the underlying Rasa conversation never stopped, so the display
      // should not look like it did either.
      'messagesEl.innerHTML = "";' +
      '(msg.entries || []).forEach(function(e){ addMsg(e.text, e.role === "user" ? "user" : "bot"); });' +
    '}' +
  '});' +
  'vscode.postMessage({type:"ready"});' +
  'inputEl.focus();' +
  '})();' +
  '</script>' +
  '</body></html>';
}
