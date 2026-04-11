/**
 * TITAN KERNEL v3.5.1 - Intelligent Enclave
 */
importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

const KERNEL_CORE = {
    active: false,
    intents: new Set(),
    // Функция самоочистки памяти
    wipe(data) {
        if (data instanceof Uint8Array) data.fill(0);
        return null;
    }
};

self.onmessage = (e) => {
    const { type, payload, intent } = e.data;

    switch (type) {
        case 'INIT':
            KERNEL_CORE.active = true;
            self.postMessage({ type: 'READY' });
            break;

        case 'ENCRYPT':
            if (!KERNEL_CORE.active) return;
            
            // Имитация AI-защиты: блокировка подозрительно коротких сообщений
            if (payload.text.length < 1) {
                self.postMessage({ type: 'ERROR', error: 'AI_SENTINEL: Payload too small' });
                return;
            }

            const nonce = nacl.randomBytes(24);
            const key = new Uint8Array(32).fill(13); // В проде - динамический ключ
            const msg = new TextEncoder().encode(payload.text);
            
            const encrypted = nacl.secretbox(msg, nonce, key);
            
            self.postMessage({ 
                type: 'CIPHER', 
                data: { 
                    cipher: btoa(String.fromCharCode(...encrypted)),
                    nonce: btoa(String.fromCharCode(...nonce))
                } 
            });

            // Мгновенная очистка временных буферов (Self-Healing Memory)
            KERNEL_CORE.wipe(msg);
            break;
    }
};
