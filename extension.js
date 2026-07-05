"use strict";
const vscode = require("vscode");
const { PolyBridgeProvider, VENDOR, getProviders } = require("./provider");
const { manageHub, addProviderWizard } = require("./ui");

async function pickProvider() {
  const providers = getProviders();
  if (providers.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      "Poly Model Bridge: 还没有配置中转站。",
      "添加中转站"
    );
    return pick === "添加中转站" ? "__add__" : undefined;
  }
  if (providers.length === 1) {
    return providers[0].name;
  }
  const pick = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: p.name, description: p.baseUrl })),
    { title: "选择中转站" }
  );
  return pick && pick.label;
}

function activate(context) {
  const provider = new PolyBridgeProvider(context.secrets);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.setApiKey", async () => {
      const name = await pickProvider();
      if (name === "__add__") {
        await addProviderWizard(provider);
      } else if (name) {
        await provider.promptForApiKey(name);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.addProvider", async () => {
      await addProviderWizard(provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.manage", async () => {
      await manageHub(provider);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("polyBridge")) {
        provider.refresh();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
