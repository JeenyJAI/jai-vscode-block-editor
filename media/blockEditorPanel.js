// Wrapper to guarantee execution after DOM loading
(function() {
    function init() {
        // All existing code from <script> block
        const vscode = acquireVsCodeApi();
        const commandsInput = document.getElementById('commandsInput');
        const applyButton = document.getElementById('applyButton');
        const statusDiv = document.getElementById('status');
        
        // Get initial state and configuration
        const state = vscode.getState() || {};
        const debugMode = state.debugMode || false;
        
        // Debug logger that respects the debug flag
        const debug = {
            log: (...args) => {
                // Read current state each time to avoid closure issue
                const currentState = vscode.getState() || {};
                if (currentState.debugMode) {
                    console.log('[BlockEditor]', ...args);
                }
            },
            error: (...args) => {
                // Always log errors
                console.error('[BlockEditor]', ...args);
            }
        };
        
        // Flag to prevent double execution
        let isProcessing = false;
        
        function showStatus(message, type = 'info') {
            if (!statusDiv) return;
            statusDiv.textContent = message;
            // Use classList for better class management
            statusDiv.classList.remove('show', 'error', 'warning', 'info');
            statusDiv.classList.add('status', 'show', type);
            setTimeout(() => {
                statusDiv.classList.remove('show');
            }, 5000);
        }
        
        // Apply button handler
        if (applyButton) {
            applyButton.addEventListener('click', () => {
                if (isProcessing) {
                    debug.log('Already processing, ignoring click');
                    return;
                }
                
                const commands = commandsInput ? commandsInput.value.trim() : '';
                debug.log('Apply button clicked, commands length:', commands.length);
                
                if (commands) {
                    debug.log('Sending message with mode: preview-and-apply');
                    isProcessing = true;
                    applyButton.disabled = true;
                    document.body.setAttribute('aria-busy', 'true'); // Set ARIA busy
                    showStatus('Processing commands...', 'info');
                    vscode.postMessage({
                        type: 'executeCommands',
                        value: commands,
                        mode: 'preview-and-apply'
                    });
                } else {
                    debug.log('No commands entered');
                    showStatus('Please enter DSL commands', 'warning');
                    vscode.postMessage({
                        type: 'showMessage',
                        value: 'Please enter DSL commands'
                    });
                }
            });
        }

        // Keyboard shortcuts - support both Ctrl and Cmd
        if (commandsInput) {
            commandsInput.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    debug.log('Keyboard shortcut triggered');
                    if (applyButton && !applyButton.disabled) {
                        applyButton.click();
                    }
                    e.preventDefault();
                }
            });
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            // Validate message type
            const allowedTypes = ['updateCommands', 'setDebugMode', 'commandsApplied', 'clearInput', 'error'];
            if (!message || typeof message.type !== 'string' || !allowedTypes.includes(message.type)) {
                debug.error('Invalid message type:', message?.type);
                return;
            }
            
            debug.log('Received message:', message.type);
            
            switch (message.type) {
                case 'updateCommands':
                    if (commandsInput) {
                        commandsInput.value = message.value;
                    }
                    // Use fresh state snapshot to avoid overwriting
                    const freshState1 = vscode.getState() || {};
                    vscode.setState({ ...freshState1, commands: message.value });
                    updateButtonState(); // Update button after programmatic change
                    break;
                    
                case 'setDebugMode':
                    // Use fresh state snapshot
                    const freshState3 = vscode.getState() || {};
                    freshState3.debugMode = message.value;
                    vscode.setState(freshState3);
                    debug.log('Debug mode set to:', message.value);
                    break;
                    
                case 'commandsApplied':
                    isProcessing = false;
                    document.body.removeAttribute('aria-busy'); // Clear ARIA busy
                    if (applyButton) {
                        applyButton.disabled = false;
                    }
                    updateButtonState(); // Sync button state after re-enabling
                    showStatus('Commands applied successfully!', 'info');
                    
                    // Use VS Code message instead of browser confirm
                    vscode.postMessage({
                        type: 'requestClearConfirmation'
                    });
                    break;
                    
                case 'clearInput':
                    if (commandsInput) {
                        commandsInput.value = '';
                    }
                    // Use fresh state snapshot to avoid overwriting
                    const freshState2 = vscode.getState() || {};
                    vscode.setState({ ...freshState2, commands: '' });
                    updateButtonState(); // Update button after clearing
                    debug.log('Input cleared');
                    break;
                    
                case 'error':
                    isProcessing = false;
                    document.body.removeAttribute('aria-busy'); // Clear ARIA busy
                    if (applyButton) {
                        applyButton.disabled = false;
                    }
                    updateButtonState(); // Sync button state after error
                    showStatus(message.value || 'An error occurred', 'error');
                    debug.error('Error received:', message.value);
                    break;
            }
        });

        // Save state on input with debouncing
        if (commandsInput) {
            let saveTimeout;
            commandsInput.addEventListener('input', (e) => {
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    // Always use fresh state to avoid overwriting
                    const freshState = vscode.getState() || {};
                    freshState.commands = e.target.value;
                    vscode.setState(freshState);
                    debug.log('State saved, length:', e.target.value.length);
                }, 500);
            });
        }

        // Restore saved commands
        if (state.commands && commandsInput) {
            commandsInput.value = state.commands;
            debug.log('Restored commands, length:', state.commands.length);
        }

        // Handle details state persistence
        const detailsElement = document.querySelector('.hint-container');
        if (detailsElement) {
            // Restore details state
            if (state.detailsOpen !== undefined) {
                detailsElement.open = state.detailsOpen;
            }
            
            // Save details state on toggle
            detailsElement.addEventListener('toggle', () => {
                const newState = vscode.getState() || {};
                newState.detailsOpen = detailsElement.open;
                vscode.setState(newState);
                debug.log('Details state saved:', detailsElement.open);
            });
        }

        // Function to update button state - reusable across handlers
        function updateButtonState() {
            if (!commandsInput || !applyButton) return;
            const hasContent = commandsInput.value.trim().length > 0;
            applyButton.disabled = !hasContent;
            applyButton.classList.toggle('disabled', !hasContent);
        }

        // Dynamic button state based on input
        if (commandsInput && applyButton) {
            // Update on input change
            commandsInput.addEventListener('input', updateButtonState);
            
            // Set initial state
            updateButtonState();
        }

        // Safe focus on input field
        if (commandsInput && typeof commandsInput.focus === 'function') {
            // Small delay to ensure proper focus
            setTimeout(() => {
                commandsInput.focus();
                debug.log('Input field focused');
            }, 100);
        }
        
        // Send ready message to extension
        vscode.postMessage({ type: 'webviewReady' });
        debug.log('Webview initialized and ready');
    }
    
    // Check DOM readiness before initialization
    if (document.readyState === 'loading') {
        // Use once: true for idempotency
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        // DOM already loaded, run immediately
        init();
    }
})();