"use strict";

const vscode = require("vscode");
const { getProviders } = require("./provider");
const { readCliState } = require("./cli");

class SidebarProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => {
      if (!message) return;
      if (message.type === "openManager") {
        vscode.commands.executeCommand("polyBridge.manage");
      } else if (message.type === "toggleCli") {
        vscode.commands.executeCommand("polyBridge.toggleCliTerminalEnv");
      }
    });
    this.refresh();
  }

  refresh() {
    if (!this.view) return;
    const providers = getProviders();
    const modelCount = providers.reduce(
      (total, provider) => total + (Array.isArray(provider.models) ? provider.models.length : 0),
      0
    );
    this.view.description = providers.length
      ? `${providers.length} 个中转站 · ${modelCount} 个模型`
      : "尚未配置";
    this.view.webview.html = this.html(providers.length, modelCount);
  }

  html(providerCount, modelCount) {
    const nonce = Math.random().toString(36).slice(2);
    const csp = [
      "default-src 'none'",
      `style-src ${this.view.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const cli = readCliState(this.context.globalState);
    const summary = providerCount
      ? `已连接 <b>${providerCount}</b> 个中转站，共 <b>${modelCount}</b> 个模型。`
      : "还没有添加中转站。";
    // The terminal switch is the one thing worth reaching without opening the
    // manager, so it gets a row here rather than only living in the panel.
    const cliRow = providerCount
      ? `<div class="row">
    <span class="dot${cli.enabled ? " on" : ""}"></span>
    <span class="row-text">终端 <code>copilot</code> ${cli.enabled ? "走中转站" : "走 GitHub 订阅"}</span>
    <button class="ghost" id="toggle-cli">${cli.enabled ? "关闭" : "开启"}</button>
  </div>`
      : "";
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{padding:12px;color:var(--vscode-foreground);font:13px var(--vscode-font-family);line-height:1.55}
.card{padding:14px;border:1px solid color-mix(in srgb,var(--vscode-foreground) 14%,transparent);border-radius:10px;background:var(--vscode-sideBar-background)}
h2{font-size:14px;font-weight:600;margin:0 0 6px}
p{margin:0 0 12px;color:var(--vscode-descriptionForeground)}
b{color:var(--vscode-foreground);font-weight:600}
button{width:100%;padding:7px;border:1px solid var(--vscode-button-border,transparent);border-radius:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
.row{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 10%,transparent)}
.row-text{flex:1;min-width:0;font-size:12px;color:var(--vscode-descriptionForeground)}
.row code{padding:0 3px;border-radius:3px;font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background)}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--vscode-descriptionForeground);opacity:.45}
.dot.on{background:var(--vscode-charts-green,#3fb950);opacity:1}
button.ghost{width:auto;padding:3px 10px;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.ghost:hover{background:var(--vscode-button-secondaryHoverBackground)}
</style>
</head>
<body>
<div class="card">
  <h2>Poly Model Bridge</h2>
  <p>${summary}</p>
  <button id="open">打开管理界面</button>
  ${cliRow}
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
document.getElementById('open').onclick=()=>vscode.postMessage({type:'openManager'});
const cliButton=document.getElementById('toggle-cli');
if(cliButton)cliButton.onclick=()=>vscode.postMessage({type:'toggleCli'});
</script>
</body>
</html>`;
  }
}

module.exports = { SidebarProvider };
