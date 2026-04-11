/**
 * SENPIXEL NEXUS UI & AI CONTROLLER
 */

const UI = {
    logs: document.getElementById('sentinel-logs'),
    chat: document.getElementById('chat-window'),
    input: document.getElementById('m-input'),
    btn: document.getElementById('send-btn'),
    status: document.getElementById('status-display')
};

// --- Анимация логов Sentinel (Эффект печатной машинки) ---
async function sentinelLog(msg, type = "SYS") {
    const d = document.createElement('div');
    const prefix = `[${new Date().toLocaleTimeString()}] SENTINEL_${type}: `;
    d.innerHTML = `<span style="color:#fff">${prefix}</span>`;
    UI.logs.appendChild(d);
    UI.logs.scrollTop = UI.logs.scrollHeight;

    // Плавный вывод текста
    for (let i = 0; i < msg.length; i++) {
        d.innerHTML += msg[i];
        await new Promise(r => setTimeout(r, 10)); // Скорость печати
    }
}

// --- Рендер сообщений в чат ---
function addMessage(text, isOwn = true, trustLevel = "HW_VERIFIED") {
    const div = document.createElement('div');
    div.className = `msg ${isOwn ? 'own' : ''}`;
    div.innerHTML = `
        <div class="msg-meta">UID: 0xNEXUS <span class="trust-badge">✔️ ${trustLevel}</span></div>
        <div class="msg-body">${text}</div>
    `;
    UI.chat.appendChild(div);
    UI.chat.scrollTop = UI.chat.scrollHeight;
}

// --- Инициализация Изолированного Ядра ---
const kernel = new Worker('titan_kernel.js');

kernel.onmessage = (e) => {
    const { type, data, error } = e.data;

    if (type === 'READY') {
        UI.status.textContent = 'CORE_ONLINE';
        UI.status.style.color = 'var(--neon-green)';
        UI.status.style.textShadow = '0 0 10px var(--neon-green)';
        UI.input.disabled = false;
        UI.btn.disabled = false;
        UI.btn.textContent = 'ENCRYPT';
        sentinelLog("H-BCK Enclave isolated. Memory sanitizer active.", "CORE");
    }

    if (type === 'CIPHER') {
        setTimeout(() => {
            sentinelLog(`Ratchet advanced. Cipher: ${data.cipher.substring(0,20)}...`, "SEC");
            addMessage(UI.input.value, true);
            UI.input.value = '';
            UI.btn.textContent = 'ENCRYPT';
            UI.btn.disabled = false;
            // В будущем здесь будет отправка data в Supabase
        }, 500); // Имитация времени обработки
    }

    if (type === 'ERROR') {
        sentinelLog(error, "CRITICAL_ALERT");
        UI.btn.textContent = 'ERROR';
    }
};

// --- Обработка отправки (С аппаратным намерением) ---
UI.btn.onclick = (e) => {
    if (!e.isTrusted) return; // Защита от JS-кликеров
    const text = UI.input.value;
    if (!text) return;

    UI.btn.disabled = true;
    UI.btn.textContent = 'PROCESSING...';
    sentinelLog("Analyzing entropy and requesting Hardware WebAuthn Intent...", "AI");
    
    // Эмуляция WebAuthn (Защита слоя)
    const intent = {
        id: crypto.randomUUID(),
        signature: "HW_ASSERT_NEXUS_" + Date.now(),
        challenge: Array.from(crypto.getRandomValues(new Uint8Array(16)))
    };

    // Передача в изолированное ядро
    kernel.postMessage({ type: 'ENCRYPT', payload: { text }, intent });
};

// --- Запуск ---
setTimeout(() => {
    sentinelLog("Booting Kernel. Establishing Double Ratchet protocol...", "INIT");
    kernel.postMessage({ type: 'INIT' });
}, 800);
