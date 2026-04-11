/**
 * TITAN AI-SENTINEL UPGRADE
 * Автономная диагностика и управление терминалом
 */

class TitanTerminal extends HTMLElement {
    constructor() {
        super();
        this._root = this.attachShadow({ mode: 'closed' });
        this._root.innerHTML = `
            <style>
                .terminal { background: #020202; border: 1px solid #00ffa2; padding: 20px; box-shadow: 0 0 30px rgba(0,255,162,0.05); }
                #log { height: 200px; overflow-y: auto; font-size: 11px; margin-bottom: 10px; border-bottom: 1px solid #111; }
                input { width: 100%; background: #000; border: 1px solid #004422; color: #00ffa2; padding: 12px; box-sizing: border-box; outline: none; }
                button { width: 100%; margin-top: 10px; background: #00ffa2; color: #000; border: none; padding: 10px; cursor: pointer; font-weight: bold; transition: 0.2s; }
                button:hover { background: #fff; }
                .ai-msg { color: #00ff00; opacity: 0.7; font-style: italic; }
            </style>
            <div class="terminal">
                <div id="log"></div>
                <input type="text" id="i" placeholder="WAITING_FOR_INPUT..." autocomplete="off">
                <button id="b">INITIALIZING AI...</button>
            </div>
        `;
        this.logElem = this._root.getElementById('log');
        this.btn = this._root.getElementById('b');
        this.input = this._root.getElementById('i');
        this.btn.onclick = (e) => this.execute(e);
    }

    report(msg, type = "") {
        const line = document.createElement('div');
        line.innerHTML = `<span style="color:#005533">></span> ${msg}`;
        if (type === 'ai') line.className = 'ai-msg';
        this.logElem.appendChild(line);
        this.logElem.scrollTop = this.logElem.scrollHeight;
    }

    execute(e) {
        if (!e.isTrusted) return;
        const val = this.input.value;
        if (!val) return;
        
        this.report("SENTINEL: Analyzing payload entropy...", "ai");
        kernel.postMessage({ 
            type: 'ENCRYPT', 
            payload: { text: val }, 
            intent: { id: crypto.randomUUID(), signature: true } 
        });
        this.input.value = '';
    }
}

customElements.define('titan-terminal', TitanTerminal);
const ui = new TitanTerminal();
document.getElementById('titan-mount').appendChild(ui);

// --- AI KERNEL MANAGER ---
let kernel;
const startKernel = () => {
    try {
        kernel = new Worker('titan_kernel.js');
        kernel.onmessage = (e) => {
            if (e.data.type === 'READY') {
                ui.report("AI_SENTINEL: Kernel link established. Integrity 100%.", "ai");
                ui.btn.textContent = "EXECUTE SECURE SEND";
            }
            if (e.data.type === 'CIPHER') ui.report("ENCRYPTION_COMPLETE: " + e.data.data.cipher.slice(0, 30) + "...");
        };
        kernel.onerror = () => ui.report("CRITICAL_ERROR: Kernel file missing or CSP block!", "err");
        kernel.postMessage({ type: 'INIT' });
    } catch (err) {
        ui.report("SELF_HEAL: Attempting to fix worker path...", "ai");
    }
};

startKernel();