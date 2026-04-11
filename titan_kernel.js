self.onmessage = (e) => {
    if (e.data.type === 'INIT') console.log("Kernel: Online");
    
    if (e.data.type === 'ENCRYPT') {
        // Имитация шифрования Double Ratchet
        const encrypted = `[SECURE_DATA] ${e.data.data}`;
        self.postMessage({ type: 'CIPHER', payload: encrypted });
    }
};
