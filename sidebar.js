"use strict";

const vscode = require("vscode");
const { getProviders } = require("./provider");

class SidebarProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => {
      if (message && message.type === "openManager") {
        vscode.commands.executeCommand("polyBridge.manage");
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
    const summary = providerCount
      ? `已连接 ${providerCount} 个中转站，共 ${modelCount} 个模型。`
      : "还没有添加中转站。";
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{padding:12px;color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
.card{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-sideBar-background)}
h2{font-size:15px;margin:0 0 7px}p{line-height:1.55;margin:0 0 14px;color:var(--vscode-descriptionForeground)}
button{width:100%;padding:8px;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
</style>
</head>
<body>
<div class="card">
  <h2>Poly Model Bridge</h2>
  <p>${summary}<br>点击下面的按钮进入完整管理界面。</p>
  <button id="open">打开管理界面</button>
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
document.getElementById('open').onclick=()=>vscode.postMessage({type:'openManager'});
</script>
</body>
</html>`;
  }
}

module.exports = { SidebarProvider };
