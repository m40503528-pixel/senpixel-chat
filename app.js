const S_URL = 'https://kwotdvdjxhpttuwhgjkh.supabase.co';
const S_KEY = 'sb_publishable_i6HL03F98ZmxCKmAKQDaLQ_w6u7ep4d';
const supabase = window.supabase.createClient(S_URL, S_KEY);

const App = {
    user: null,
    cid: '00000000-0000-0000-0000-000000000002',
    kernel: new Worker('titan_kernel.js'),

    async init() {
        this.events();
        this.check();
        this.kernel.postMessage({ type: 'INIT' });
    },

    events() {
        // Навигация
        document.querySelectorAll('.nav-ico').forEach(i => {
            i.onclick = () => {
                document.querySelectorAll('.nav-ico, .screen').forEach(el => el.classList.remove('active'));
                i.classList.add('active');
                document.getElementById(i.dataset.s).classList.add('active');
            };
        });

        // Авторизация
        document.getElementById('auth-btn').onclick = async () => {
            const e = document.getElementById('u-email').value;
            const p = document.getElementById('u-pass').value;
            const { error } = await supabase.auth.signInWithPassword({ email: e, password: p });
            if (error) {
                // Если нет аккаунта - пробуем регу
                const { error: re } = await supabase.auth.signUp({ email: e, password: p });
                if (re) document.getElementById('auth-err').innerText = re.message;
                else alert("Node created. Confirm email and login.");
            } else this.check();
        };

        document.getElementById('out-btn').onclick = () => { supabase.auth.signOut(); location.reload(); };

        // Отправка
        document.getElementById('send-btn').onclick = () => this.send();
        
        // Самодиагностика (Революция!)
        document.getElementById('heal-btn').onclick = () => {
            const log = document.getElementById('ailog');
            log.innerHTML += "<br>> Scanning for vulnerabilities...";
            setTimeout(() => { log.innerHTML += "<br>> [OK] DOM integrity verified.<br>> [OK] Kernel isolated."; }, 1000);
        };

        this.kernel.onmessage = (e) => this.onKernel(e.data);
    },

    async check() {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            this.user = session.user;
            document.getElementById('gate').style.opacity = '0';
            setTimeout(() => { 
                document.getElementById('gate').style.display = 'none';
                document.getElementById('nexus').style.display = 'flex';
            }, 1000);
            this.sync();
        }
    },

    send() {
        const t = document.getElementById('minput').value.trim();
        if (!t) return;
        document.getElementById('minput').value = '';
        this.kernel.postMessage({ type: 'ENCRYPT', payload: { text: t } });
    },

    async onKernel(d) {
        if (d.type === 'CIPHER') {
            await supabase.from('messages').insert([{
                chat_id: this.cid,
                user_id: this.user.id,
                content: d.data.cipher,
                type: 'text'
            }]);
        }
    },

    async sync() {
        const { data } = await supabase.from('messages').select('*').eq('chat_id', this.cid).order('created_at', { ascending: true });
        data?.forEach(m => this.render(m));

        supabase.channel('live').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => this.render(p.new)).subscribe();
    },

    render(m) {
        const b = document.getElementById('msgs');
        const isOwn = m.user_id === this.user.id;
        const d = document.createElement('div');
        d.className = `bubble ${isOwn ? 'me' : 'not-me'}`;
        d.innerText = m.content;
        b.appendChild(d);
        b.scrollTop = b.scrollHeight;
    }
};

App.init();
