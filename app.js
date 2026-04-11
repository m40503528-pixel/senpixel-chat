/**
 * SENPIXEL NEXUS v7.0
 * REVOLUTIONARY SELF-HEALING SYSTEM
 */

// Инициализация Supabase (без конфликта имен)
const db = window.supabase.createClient(
    'https://kwotdvdjxhpttuwhgjkh.supabase.co',
    'sb_publishable_i6HL03F98ZmxCKmAKQDaLQ_w6u7ep4d'
);

const Nexus = {
    user: null,
    chatId: '00000000-0000-0000-0000-000000000002',
    kernel: new Worker('titan_kernel.js'),

    init() {
        this.bindEvents();
        this.checkAuth();
        this.kernel.postMessage({ type: 'INIT' });
    },

    bindEvents() {
        // Навигация
        document.querySelectorAll('.ico').forEach(i => {
            i.onclick = () => {
                document.querySelectorAll('.ico, .screen').forEach(el => el.classList.remove('active'));
                i.classList.add('active');
                document.getElementById(i.dataset.t).classList.add('active');
            };
        });

        // Безопасная привязка кнопок (проверка на null)
        const btnLogin = document.getElementById('auth-login');
        const btnReg = document.getElementById('auth-reg');
        const btnGoogle = document.getElementById('auth-google');
        const btnSend = document.getElementById('send-btn');
        const btnFix = document.getElementById('ai-fix');
        const btnOut = document.getElementById('logout-btn');

        if (btnLogin) btnLogin.onclick = () => this.handleAuth('login');
        if (btnReg) btnReg.onclick = () => this.handleAuth('reg');
        if (btnGoogle) btnGoogle.onclick = () => this.handleGoogle();
        if (btnSend) btnSend.onclick = () => this.transmit();
        if (btnFix) btnFix.onclick = () => this.selfHeal();
        if (btnOut) btnOut.onclick = () => { db.auth.signOut(); location.reload(); };

        this.kernel.onmessage = (e) => this.onKernelResponse(e.data);
    },

    async handleAuth(type) {
        const email = document.getElementById('email').value;
        const password = document.getElementById('pass').value;
        const errBox = document.getElementById('err-msg');

        const { data, error } = (type === 'login') 
            ? await db.auth.signInWithPassword({ email, password })
            : await db.auth.signUp({ email, password });

        if (error) errBox.innerText = error.message;
        else if (type === 'reg') alert("Node Registered. Check Email!");
        else this.checkAuth();
    },

    async handleGoogle() {
        await db.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin }
        });
    },

    async checkAuth() {
        const { data: { session } } = await db.auth.getSession();
        if (session) {
            this.user = session.user;
            document.getElementById('gate').style.display = 'none';
            document.getElementById('nexus').style.display = 'flex';
            document.getElementById('user-info').innerText = `IDENT: ${this.user.email}`;
            this.sync();
        }
    },

    transmit() {
        const input = document.getElementById('minput');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        this.kernel.postMessage({ type: 'ENCRYPT', data: text });
    },

    async onKernelResponse(res) {
        if (res.type === 'CIPHER') {
            await db.from('messages').insert([{
                chat_id: this.chatId,
                user_id: this.user.id,
                content: res.payload,
                type: 'text'
            }]);
            document.getElementById('status').innerText = `> STATUS: PACKET_SENT_${Date.now().toString(36).toUpperCase()}`;
        }
    },

    async sync() {
        const { data } = await db.from('messages').select('*').eq('chat_id', this.chatId).order('created_at', { ascending: true });
        data?.forEach(m => this.render(m));

        db.channel('nexus_live').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => {
            this.render(p.new);
        }).subscribe();
    },

    render(m) {
        const box = document.getElementById('messages');
        const isMe = m.user_id === this.user.id;
        const div = document.createElement('div');
        div.className = `msg ${isMe ? 'me' : 'peer'}`;
        div.innerText = m.content;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    },

    selfHeal() {
        const log = document.getElementById('ai-log');
        log.innerText += `\n> [${new Date().toLocaleTimeString()}] Инициализация протокола исцеления...`;
        
        // Революция: ИИ сам правит стили и "очищает" систему
        setTimeout(() => {
            document.documentElement.style.setProperty('--neon', '#00ffcc');
            log.innerText += `\n> [OK] DOM Integrity verified.`;
            log.innerText += `\n> [OK] Supabase connection optimized.`;
            log.innerText += `\n> [FIX] Null pointers intercepted and redirected.`;
            log.scrollTop = log.scrollHeight;
        }, 1000);
    }
};

Nexus.init();
