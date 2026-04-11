importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');

let state = { step: 0, key: new Uint8Array(32).fill(1) };

self.onmessage = (e) => {
    if (e.data.type === 'INIT') self.postMessage({ type: 'READY' });
    
    if (e.data.type === 'ENCRYPT') {
        const msg = new TextEncoder().encode(e.data.payload.text);
        const nonce = nacl.randomBytes(24);
        const box = nacl.secretbox(msg, nonce, state.key);
        
        state.step++;
        // На лету меняем ключ для следующего сообщения
        state.key = nacl.hash(state.key).slice(0, 32);

        self.postMessage({
            type: 'CIPHER',
            data: { cipher: e.data.payload.text, step: state.step } 
        });
    }
};
