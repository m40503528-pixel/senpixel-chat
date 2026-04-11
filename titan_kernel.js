importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

const CORE = {
    ratchet: { rootKey: new Uint8Array(32).fill(7), steps: 0 },
    advance() {
        this.ratchet.rootKey = nacl.hash(this.ratchet.rootKey).slice(0, 32);
        this.ratchet.steps++;
    }
};

self.onmessage = (e) => {
    const { type, payload } = e.data;
    if (type === 'INIT') self.postMessage({ type: 'READY' });
    if (type === 'ENCRYPT') {
        const nonce = nacl.randomBytes(24);
        const msg = new TextEncoder().encode(payload.text);
        const box = nacl.secretbox(msg, nonce, CORE.ratchet.rootKey);
        CORE.advance();
        self.postMessage({ 
            type: 'CIPHER', 
            data: { cipher: btoa(String.fromCharCode(...box)), ratchetStep: CORE.ratchet.steps } 
        });
    }
};
