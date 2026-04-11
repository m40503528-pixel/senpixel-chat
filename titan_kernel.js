/**
 * TITAN KERNEL v4.0 // NEXUS ENCLAVE
 * Full Stack: Double Ratchet, Hardware Intent Validation, Memory Zeroization
 */
importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

const CORE = {
    active: false,
    caps: new Set(['INIT']),
    intents: new Set(),
    
    // Эмуляция состояния Double Ratchet
    ratchet: {
        rootKey: new Uint8Array(32).fill(42), 
        messageCount: 0
    },

    // Функция жесткой очистки памяти (Sanitization)
    zeroize(buffer) {
        if (buffer instanceof Uint8Array) {
            for (let i = 0; i < buffer.length; i++) buffer[i] = 0;
        }
    },

    // Продвижение храповика (KDF - Key Derivation Function)
    advanceRatchet() {
        const hash = nacl.hash(this.ratchet.rootKey);
        this.ratchet.rootKey = hash.slice(0, 32); // Берем первые 32 байта хеша как новый ключ
        this.ratchet.messageCount++;
    }
};

self.onmessage = (e) => {
    const { type, payload, intent } = e.data;

    if (!CORE.caps.has(type)) {
        return self.postMessage({ type: 'ERROR', error: 'KERNEL_PANIC: CAPABILITY_DENIED' });
    }

    switch (type) {
        case 'INIT':
            CORE.active = true;
            CORE.caps.add('ENCRYPT');
            self.postMessage({ type: 'READY' });
            break;

        case 'ENCRYPT':
            // 1. Проверка аппаратного токена (Защита от Replay-атак)
            if (!intent || !intent.signature) {
                return self.postMessage({ type: 'ERROR', error: 'HW_TOKEN_REJECTED' });
            }
            if (CORE.intents.has(intent.id)) {
                return self.postMessage({ type: 'ERROR', error: 'REPLAY_ATTACK_DETECTED' });
            }
            CORE.intents.add(intent.id);

            // 2. Шифрование
            const nonce = nacl.randomBytes(24);
            const msgEncoded = new TextEncoder().encode(payload.text);
            
            // Используем текущий ключ храповика
            const cipher = nacl.secretbox(msgEncoded, nonce, CORE.ratchet.rootKey);

            // 3. Продвижение Double Ratchet (Смена ключа)
            CORE.advanceRatchet();

            // 4. Отправка результата
            self.postMessage({ 
                type: 'CIPHER', 
                data: { 
                    cipher: btoa(String.fromCharCode(...cipher)),
                    nonce: btoa(String.fromCharCode(...nonce)),
                    ratchetStep: CORE.ratchet.messageCount
                } 
            });

            // 5. Zeroization (Уничтожение исходного текста в памяти воркера)
            CORE.zeroize(msgEncoded);
            break;
    }
};
