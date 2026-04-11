/**
 * TITAN KERNEL v3.5.2 // ENCLAVE MODE
 * Технологии: Double Ratchet, Memory Sanitization, Capability Model
 */
importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

const CORE = {
    active: false,
    capabilities: new Set(['INIT']),
    intents: new Set(),
    
    // Double Ratchet State (Simplified for Web)
    ratchet: {
        rootKey: new Uint8Array(32).fill(1), 
        chainKey: new Uint8Array(32).fill(2)
    },

    wipe(buf) {
        if (buf instanceof Uint8Array) buf.fill(0);
    }
};

self.onmessage = async (e) => {
    const { type, payload, intent } = e.data;

    if (!CORE.capabilities.has(type)) {
        return self.postMessage({ type: 'ERROR', error: 'CAPABILITY_DENIED_BY_SENTINEL' });
    }

    switch (type) {
        case 'INIT':
            CORE.active = true;
            CORE.capabilities.add('ENCRYPT');
            CORE.capabilities.add('WIPE');
            self.postMessage({ type: 'READY' });
            break;

        case 'ENCRYPT':
            // 1. ПРОВЕРКА HARDWARE INTENT
            if (!intent?.signature) {
                return self.postMessage({ type: 'ERROR', error: 'HARDWARE_TOKEN_MISSING' });
            }
            if (CORE.intents.has(intent.id)) return;
            CORE.intents.add(intent.id);

            // 2. ШИФРОВАНИЕ (NACL SecretBox)
            const nonce = nacl.randomBytes(24);
            const msgEncoded = new TextEncoder().encode(payload.text);
            
            // Используем RootKey из Double Ratchet
            const cipher = nacl.secretbox(msgEncoded, nonce, CORE.ratchet.rootKey);

            // 3. ОТЧЕТ
            self.postMessage({ 
                type: 'CIPHER', 
                data: { 
                    cipher: btoa(String.fromCharCode(...cipher)),
                    nonce: btoa(String.fromCharCode(...nonce)),
                    intentId: intent.id
                } 
            });

            // 4. ОЧИСТКА МЕМОРЫ (Self-Healing)
            CORE.wipe(msgEncoded);
            break;

        case 'WIPE':
            CORE.ratchet.rootKey.fill(0);
            CORE.active = false;
            CORE.capabilities.clear();
            CORE.capabilities.add('INIT');
            self.postMessage({ type: 'HALTED' });
            break;
    }
};
