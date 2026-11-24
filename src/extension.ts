/**
 * Muse Code Chat (Unofficial) — VS Code extension entry point.
 *
 * Unofficial community project. Not made, endorsed, or supported by Meta.
 * Not affiliated with Meta. Requires the Muse Code CLI and the user's own
 * Muse Code login. This extension never stores credentials and never
 * talks to muse.ai — there is no public Muse personal-assistant API.
 */
import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { checkSetup, INSTALL_INSTRUCTIONS } from './museCli';
import { writeBundle } from './bundle';

export function activate(context: vscode.ExtensionContext): void {
  const panel = new ChatPanel(context);
  context.subscriptions.push(panel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  const register = (command: string, fn: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, fn));
  };

  register('museCode.openChat', () => {
    void vscode.commands.executeCommand('workbench.view.extension.muse-code');
    panel.focus();
  });

  register('museCode.newChat', () => panel.newChat());

  register('museCode.openTerminal', () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({ name: 'Muse Code', cwd: folder });
    terminal.show();
    terminal.sendText('muse');
  });

  register('museCode.checkSetup', async () => {
    const config = vscode.workspace.getConfiguration('museCode');
    const setup = checkSetup(config.get<string>('executablePath', ''));
    if (setup.ok) {
      await panel.ensureClient();
      void vscode.window.showInformationMessage(`Muse Code Chat: found muse CLI at ${setup.executable}`);
    } else {
      const choice = await vscode.window.showWarningMessage(
        `Muse Code Chat: ${setup.reason}`,
        'Show install instructions',
        'Sign in',
      );
      if (choice === 'Show install instructions') {
        void vscode.window.showInformationMessage(
          `Install Muse Code — macOS/Linux: ${INSTALL_INSTRUCTIONS.macLinux} — Windows PowerShell: ${INSTALL_INSTRUCTIONS.windows}`,
        );
      } else if (choice === 'Sign in') {
        await vscode.commands.executeCommand('museCode.signIn');
      }
    }
  });

  register('museCode.signIn', () => {
    // Runs in a terminal the user can see. The CLI owns the login flow
    // and its credentials; this extension never sees them.
    const terminal = vscode.window.createTerminal('Muse Code sign-in');
    terminal.show();
    terminal.sendText('muse login');
  });

  register('museCode.copySelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Muse Code Chat: select some code first.');
      return;
    }
    const text = editor.document.getText(editor.selection);
    const bundle = `File: ${editor.document.fileName}\n\`\`\`${editor.document.languageId}\n${text}\n\`\`\``;
    await vscode.env.clipboard.writeText(bundle);
    void vscode.window.showInformationMessage('Muse Code Chat: selection copied — paste it into the chat panel.');
  });

  register('museCode.bundleProject', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage('Muse Code Chat: open a project folder first.');
      return;
    }
    try {
      const outPath = writeBundle(folder.uri.fsPath);
      const open = await vscode.window.showInformationMessage(`Muse Code Chat: wrote ${outPath}`, 'Open');
      if (open === 'Open') {
        void vscode.window.showTextDocument(vscode.Uri.file(outPath));
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Muse Code Chat: could not bundle project — ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function deactivate(): void {
  // The ChatPanel is disposed via context.subscriptions.
}
