import * as vscode from 'vscode';

/**
 * Escapes HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
    const htmlEscapes: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return str.replace(/[&<>"']/g, char => htmlEscapes[char] || char);
}

/**
 * Generates a cryptographically secure nonce for CSP (base64 format)
 */
function generateNonce(): string {
    const array = new Uint8Array(32);
    
    // Use crypto API if available (works in both Node and Web contexts)
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        globalThis.crypto.getRandomValues(array);
    } else {
        // Fallback for older Node.js versions
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('crypto').randomFillSync(array);
        } catch {
            // No fallback to Math.random() - fail securely
            throw new Error('Unable to generate secure nonce - no crypto API available');
        }
    }
    
    // Convert to base64 (CSP specification format)
    // Remove padding as per CSP spec
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(array).toString('base64').replace(/=+$/, '');
    } else {
        // Web environment fallback
        let binary = '';
        for (let i = 0; i < array.length; i++) {
            const byte = array[i];
            if (byte !== undefined) {
                binary += String.fromCharCode(byte);
            }
        }
        return btoa(binary).replace(/=+$/, '');
    }
}

/**
 * Generates HTML content for the Block Editor webview
 */
export async function generateBlockEditorHtml(
    extensionUri: vscode.Uri,
    webview: vscode.Webview
): Promise<string> {
    try {
        // Generate nonce for CSP
        const nonce = generateNonce();
        
        // Create webview URIs for resources
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'media', 'blockEditorPanel.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'media', 'blockEditorPanel.js')
        );
        const cspSource = webview.cspSource;
        
        // Read version from package.json
        let version = '0.0.0'; // fallback version
        try {
            const packageJsonUri = vscode.Uri.joinPath(extensionUri, 'package.json');
            const packageJsonBytes = await vscode.workspace.fs.readFile(packageJsonUri);
            const packageJson = JSON.parse(new TextDecoder('utf-8').decode(packageJsonBytes));
            version = packageJson.version || version;
        } catch (error) {
            console.warn('Failed to read version from package.json:', error);
            // Continue with fallback version
        }
        
        // Read HTML template using VS Code API (works in Web and Desktop)
        const htmlUri = vscode.Uri.joinPath(extensionUri, 'media', 'blockEditorPanel.html');
        const htmlBytes = await vscode.workspace.fs.readFile(htmlUri);
        let html = new TextDecoder('utf-8').decode(htmlBytes);
        
        // Replace placeholders
        html = html
            .replace(/\${version}/g, version)  // Version from package.json
            .replace(/\${nonce}/g, nonce)  // All occurrences of nonce
            .replace(/\${cssUri}/g, cssUri.toString())
            .replace(/\${jsUri}/g, jsUri.toString())
            .replace(/\${cspSource}/g, cspSource);
        
        return html;
        
    } catch (error) {
        console.error('Failed to generate webview HTML:', error);
        
        // Fallback HTML with complete symmetric CSP
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" 
                      content="default-src 'none'; 
                               img-src 'none';
                               font-src 'none';
                               style-src 'unsafe-inline';
                               script-src 'none';
                               connect-src 'none';
                               worker-src 'none';
                               media-src 'none';
                               manifest-src 'none';
                               object-src 'none';
                               base-uri 'none';
                               form-action 'none';
                               frame-ancestors 'none';">
                <title>Block Editor - Error</title>
                <style>
                    body { 
                        font-family: var(--vscode-font-family); 
                        padding: 20px;
                        color: var(--vscode-foreground);
                        background: var(--vscode-panel-background);
                    }
                    h1 { color: var(--vscode-errorForeground); }
                </style>
            </head>
            <body>
                <h1>Error loading Block Editor</h1>
                <p>Failed to load the webview resources. Please try reloading the window.</p>
                <p>Error: ${error instanceof Error ? escapeHtml(error.message) : 'Unknown error'}</p>
            </body>
            </html>`;
    }
}