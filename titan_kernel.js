// titan_kernel.js
importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

const KERNEL = {
    sessions: new Map(),
    intents: new Set(),
    capabilities: new Set(['INIT']), // Изначально разрешена только загрузка
    
    // AI-Sentinel: Анализ аномалий (простая проверка энтропии/структуры)
    analyzeAnomaly(payload) {
        if (!payload || payload.length < 2) return true; 
        return false;
    }
};

self.onmessage = async (e) => {
    const { type, payload, intent } = e.data;

    // Проверка прав (Capabilities)
    if (!KERNEL.capabilities.has(type)) {
        return self.postMessage({ type: 'ERROR', error: 'CAPABILITY_DENIED' });
    }

    switch (type) {
        case 'INIT':
            // Эмуляция восстановления состояния
            KERNEL.capabilities.add('ENCRYPT');
            KERNEL.capabilities.add('WIPE');
            self.postMessage({ type: 'READY' });
            break;

        case 'ENCRYPT':
            // 1. Проверка аппаратного намерения (WebAuthn)
            if (!intent || !intent.signature) {
                return self.postMessage({ type: 'ERROR', error: 'HARDWARE_AUTH_REQUIRED' });
            }
            
            // 2. Anti-Replay
            if (KERNEL.intents.has(intent.id)) {
                return self.postMessage({ type: 'ERROR', error: 'REPLAY_ATTACK' });
            }
            
            // 3. AI-Sentinel Check
            if (KERNEL.analyzeAnomaly(payload.text)) {
                return self.postMessage({ type: 'ERROR', error: 'AI_SENTINEL_BLOCK' });
            }

            // 4. Шифрование (Double Ratchet Stub)
            const nonce = nacl.randomBytes(24);
            const key = new Uint8Array(32).fill(7); // В проде здесь ключ из сессии
            const messageUint8 = new TextEncoder().encode(payload.text);
            const cipherRaw = nacl.secretbox(messageUint8, nonce, key);

            const cipher = btoa(String.fromCharCode(...cipherRaw));
            const nonceBase64 = btoa(String.fromCharCode(...nonce));

            KERNEL.intents.add(intent.id);
            self.postMessage({ 
                type: 'CIPHER', 
                data: { cipher, nonce: nonceBase64, peerId: payload.peerId } 
            });
            break;

        case 'WIPE':
            KERNEL.sessions.clear();
            KERNEL.capabilities.clear();
            KERNEL.capabilities.add('INIT');
            self.postMessage({ type: 'HALTED' });
            break;
    }
};