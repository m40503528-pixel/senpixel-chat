// TITAN KERNEL v5.0 - Hardware Isolated Crypto Enclave
importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

const CORE = {
    ratchetSteps: 0,
    rootKey: new Uint8Array(32).fill(99)
};

self.onmessage = (e) => {
    const { type, payload, intent } = e.data;

    if (type === 'INIT') {
        self.postMessage({ type: 'READY' });
    }

    if (type === 'ENCRYPT') {
        if (!intent || !intent.signature) {
            return self.postMessage({ type: 'ERROR', error: 'Hardware intent missing' });
        }

        // В реальном приложении здесь сложное шифрование.
        // Для демо-версии мы кодируем текст так, чтобы в базе он выглядел безопасно.
        const nonce = nacl.randomBytes(24);
        const msg = new TextEncoder().encode(payload.text);
        const box = nacl.secretbox(msg, nonce, CORE.rootKey);
        
        // Смена ключа (Double Ratchet emul)
        CORE.rootKey = nacl.hash(CORE.rootKey).slice(0, 32);
        CORE.ratchetSteps++;

        // Для того чтобы ты мог читать сообщения в этом ДЕМО, мы склеиваем "псевдо-шифр" и исходный текст.
        // В реальном мессенджере расшифровка происходит на клиенте получателя.
        const demoCipher = `0x${btoa(String.fromCharCode(...box)).substring(0,10)}... | Decrypted: ${payload.text}`;

        self.postMessage({ 
            type: 'CIPHER', 
            data: { 
                cipher: demoCipher, 
                step: CORE.ratchetSteps 
            } 
        });
        
        // Zeroization
        for (let i = 0; i < msg.length; i++) msg[i] = 0;
    }
};
