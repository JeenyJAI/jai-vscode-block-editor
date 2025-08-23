// Wrapper to guarantee execution after DOM loading
(function() {
    function init() {
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
                const currentState = vscode.getState() || {};
                if (currentState.debugMode) {
                    console.log('[BlockEditor]', ...args);
                }
            },
            error: (...args) => {
                console.error('[BlockEditor]', ...args);
            }
        };
        
        // Flag to prevent double execution
        let isProcessing = false;
        
        // Centralized busy state management
        // Store original button text once at initialization
        const ORIGINAL_BUTTON_TEXT = applyButton ? applyButton.textContent : 'Apply Changes';
        
        function setBusy(isBusy, statusMessage = '') {
            isProcessing = isBusy;
            
            // Button state management
            if (applyButton) {
                applyButton.disabled = isBusy;
                applyButton.classList.toggle('is-processing', isBusy);
                
                // Update button text during processing or restore original
                if (isBusy && statusMessage) {
                    applyButton.textContent = statusMessage;
                } else if (!isBusy) {
                    // Always restore original text when unlocking
                    applyButton.textContent = ORIGINAL_BUTTON_TEXT;
                }
            }
            
            // ARIA attributes for accessibility
            document.body.setAttribute('aria-busy', isBusy ? 'true' : 'false');
            
            // Input field management
            if (commandsInput) {
                commandsInput.readOnly = isBusy;
                commandsInput.classList.toggle('is-processing', isBusy);
            }
            
            // Show status if message provided
            if (statusMessage) {
                showStatus(statusMessage, 'info');
            }
            
            debug.log(`UI busy state: ${isBusy}`, statusMessage);
        }
        
        function showStatus(message, type = 'info') {
            if (!statusDiv) return;
            statusDiv.textContent = message;
            statusDiv.classList.remove('show', 'error', 'warning', 'info', 'success');
            statusDiv.classList.add('status', 'show', type);
            
            // Auto-hide after 5 seconds
            clearTimeout(statusDiv._hideTimeout);
            statusDiv._hideTimeout = setTimeout(() => {
                statusDiv.classList.remove('show');
            }, 5000);
        }
        
        // Apply button handler with double-click protection
        if (applyButton) {
            applyButton.addEventListener('click', (e) => {
                // Double-click protection
                if (isProcessing) {
                    debug.log('Already processing, ignoring click');
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                
                const commands = commandsInput ? commandsInput.value.trim() : '';
                debug.log('Apply button clicked, commands length:', commands.length);
                
                if (commands) {
                    debug.log('Sending message with mode: preview-and-apply');
                    setBusy(true, 'Analyzing...');
                    
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
                    if (applyButton && !applyButton.disabled && !isProcessing) {
                        applyButton.click();
                    }
                    e.preventDefault();
                }
            });
        }

        // Enhanced message handler
        window.addEventListener('message', event => {
            const message = event.data;
            
            // Extended list of allowed message types
            const allowedTypes = [
                'updateCommands', 'setDebugMode', 'commandsApplied', 'clearInput', 'error',
                // New state management message types
                'processing:start', 'processing:end', 'processing:cancelled',
                'processing:error', 'processing:complete', 'applying:changes',
                'showing:analysis'
            ];
            
            if (!message || typeof message.type !== 'string') {
                debug.error('Invalid message:', message);
                return;
            }
            
            // Process only known types, ignore others
            if (!allowedTypes.includes(message.type)) {
                debug.log('Unknown message type (ignoring):', message.type);
                return;
            }
            
            debug.log('Received message:', message.type);
            
            switch (message.type) {
                // State management handlers
                case 'processing:start':
                    setBusy(true, 'Processing...');
                    break;
                
                case 'showing:analysis':
                    // During analysis dialog, only block UI without changing text
                    setBusy(true);
                    break;
                    
                case 'applying:changes':
                    setBusy(true, 'Applying changes...');
                    break;
                    
                case 'processing:cancelled':
                    setBusy(false);
                    showStatus('Operation cancelled', 'warning');
                    debug.log('Operation cancelled by user');
                    break;
                    
                case 'processing:error':
                    setBusy(false);
                    showStatus(message.error || 'An error occurred', 'error');
                    debug.error('Processing error:', message.error);
                    break;
                    
                case 'processing:complete':
                    setBusy(false);
                    showStatus('Operation completed', 'success');
                    break;
                    
                case 'processing:end':
                    // Final unlock guarantee
                    setBusy(false);
                    break;
                    
                // Existing handlers (updated)
                case 'updateCommands':
                    if (commandsInput) {
                        commandsInput.value = message.value;
                    }
                    const freshState1 = vscode.getState() || {};
                    vscode.setState({ ...freshState1, commands: message.value });
                    updateButtonState();
                    break;
                    
                case 'setDebugMode':
                    const freshState3 = vscode.getState() || {};
                    freshState3.debugMode = message.value;
                    vscode.setState(freshState3);
                    debug.log('Debug mode set to:', message.value);
                    break;
                    
                case 'commandsApplied':
                    setBusy(false);
                    showStatus('Commands applied successfully!', 'success');
                    
                    // Use VS Code message instead of browser confirm
                    vscode.postMessage({
                        type: 'requestClearConfirmation'
                    });
                    break;
                    
                case 'clearInput':
                    if (commandsInput) {
                        commandsInput.value = '';
                    }
                    const freshState2 = vscode.getState() || {};
                    vscode.setState({ ...freshState2, commands: '' });
                    updateButtonState();
                    debug.log('Input cleared');
                    break;
                    
                case 'error':
                    setBusy(false);
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

        // Function to update button state
        function updateButtonState() {
            if (!commandsInput || !applyButton) return;
            
            // Don't change state if processing is active
            if (isProcessing) return;
            
            const hasContent = commandsInput.value.trim().length > 0;
            applyButton.disabled = !hasContent;
            applyButton.classList.toggle('disabled', !hasContent);
        }

        // Dynamic button state based on input
        if (commandsInput && applyButton) {
            commandsInput.addEventListener('input', updateButtonState);
            updateButtonState();
        }

        // Safe focus on input field
        if (commandsInput && typeof commandsInput.focus === 'function') {
            setTimeout(() => {
                // Don't focus if processing is active
                if (!isProcessing) {
                    commandsInput.focus();
                    debug.log('Input field focused');
                }
            }, 100);
        }
        
        // Timeout protection against UI freezing
        // Automatic unlock after 30 seconds
        let processingTimeout;
        const originalSetBusy = setBusy;
        setBusy = function(isBusy, statusMessage) {
            clearTimeout(processingTimeout);
            
            if (isBusy) {
                processingTimeout = setTimeout(() => {
                    debug.error('Processing timeout - auto unlocking UI');
                    originalSetBusy(false);
                    showStatus('Operation timed out', 'warning');
                }, 30000); // 30 seconds timeout
            }
            
            originalSetBusy(isBusy, statusMessage);
        };
        
        // Send ready message to extension
        vscode.postMessage({ type: 'webviewReady' });
        debug.log('Webview initialized and ready');
    }
    
    // Check DOM readiness before initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();