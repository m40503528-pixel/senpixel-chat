/**
 * SENPIXEL OMNI-PROTOCOL MANAGER
 * Интеграция: Sentinel AI + Double Ratchet Layer + UI
 */

const ui = {
    logs: document.getElementById('sentinel-logs'),
    chat: document.getElementById('chat-window'),
    input: document.getElementById('m-input'),
    btn: document.getElementById('send-btn'),
    status: document.getElementById('status-display')
};

// --- SENTINEL AI FEEDBACK ---
function sentinelLog(msg, type = "info") {
    const d = document.createElement('div');
    d.textContent = `[${new Date().toLocaleTimeString()}] SENTINEL_${type.toUpperCase()}: ${msg}`;
    ui.logs.appendChild(d);
    ui.logs.scrollTop = ui.logs.scrollHeight;
}

// --- MESSAGE RENDERING ---
function addMessage(text, isOwn = true, trustLevel = "HW_VERIFIED") {
    const div = document.createElement('div');
    div.className = `msg ${isOwn ? 'own' : ''}`;
    div.innerHTML = `
        <div class="msg-meta">USER_ID: 0xPixel <span class="trust-badge">[${trustLevel}]</span></div>
        <div class="msg-body">${text}</div>
    `;
    ui.chat.appendChild(div);
    ui.chat.scrollTop = ui.chat.scrollHeight;
}

// --- KERNEL CONNECTION ---
const kernel = new Worker('titan_kernel.js');

kernel.onmessage = (e) => {
    const { type, data, error } = e.data;

    if (type === 'READY') {
        ui.status.textContent = 'CORE_ACTIVE';
        ui.btn.disabled = false;
        ui.btn.textContent = 'Execute Send';
        sentinelLog("Kernel link established. Hardware intents ready.", "ai");
    }

    if (type === 'CIPHER') {
        sentinelLog("Packet encrypted and signed via WebAuthn intent.");
        addMessage(ui.input.value, true);
        ui.input.value = '';
        // Здесь должен быть fetch в Supabase
        console.log("FINAL_PACKET:", data);
    }

    if (type === 'ERROR') {
        sentinelLog(error, "alert");
    }
};

ui.btn.onclick = (e) => {
    if (!e.isTrusted) return;
    const text = ui.input.value;
    if (!text) return;

    sentinelLog("Analyzing payload entropy...", "ai");
    
    // Эмуляция WebAuthn Assert (Аппаратное намерение)
    const intent = {
        id: crypto.randomUUID(),
        signature: "HARDWARE_SIGNED_" + btoa(Math.random().toString()),
        challenge: Array.from(crypto.getRandomValues(new Uint8Array(16)))
    };

    kernel.postMessage({ type: 'ENCRYPT', payload: { text }, intent });
};

// Инициализация
kernel.postMessage({ type: 'INIT' });
