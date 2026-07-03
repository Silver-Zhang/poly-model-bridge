"use strict";
const vscode = require("vscode");
const { AnthropicCompatProvider, VENDOR } = require("./provider");

function activate(context) {
  const provider = new AnthropicCompatProvider(context.secrets);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anthropicCompat.setApiKey", async () => {
      await provider.promptForApiKey();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anthropicCompat.manage", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(key) Set / update API key", action: "key" },
          { label: "$(gear) Configure base URL & models", action: "settings" },
        ],
        { title: "Anthropic Compatible Provider" }
      );
      if (pick && pick.action === "key") {
        await provider.promptForApiKey();
      } else if (pick && pick.action === "settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "anthropicCompat"
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("anthropicCompat")) {
        provider.refresh();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
