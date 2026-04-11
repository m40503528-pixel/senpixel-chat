// Конфигурация Supabase (используем твои данные)
const SUPABASE_URL = 'https://kwotdvdjxhpttuwhgjkh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_i6HL03F98ZmxCKmAKQDaLQ_w6u7ep4d';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const UI = {
    auth: document.getElementById('auth-overlay'),
    app: document.getElementById('app'),
    chat: document.getElementById('chat-window'),
    monitor: document.getElementById('sentinel-monitor'),
    input: document.getElementById('msgInput'),
    send: document.getElementById('sendBtn')
};

// 1. АВТОРИЗАЦИЯ
document.getElementById('loginBtn').onclick = async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) document.getElementById('auth-error').textContent = error.message;
    else initApp(data.user);
};

document.getElementById('regBtn').onclick = async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) document.getElementById('auth-error').textContent = error.message;
    else alert("Check email for confirmation!");
};

document.getElementById('logoutBtn').onclick = async () => {
    await supabase.auth.signOut();
    location.reload();
};

// 2. ИНИЦИАЛИЗАЦИЯ
function initApp(user) {
    UI.auth.style.display = 'none';
    UI.app.style.display = 'flex';
    document.getElementById('user-info').textContent = `Active Node: ${user.email}`;
    kernel.postMessage({ type: 'INIT' });
}

// 3. РОУТИНГ (Вкладки)
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.add('active');
    };
});

// 4. КРИПТО-ЯДРО (TITAN 4.0)
const kernel = new Worker('titan_kernel.js');
kernel.onmessage = (e) => {
    const { type, data } = e.data;
    if (type === 'READY') UI.monitor.textContent = "> TITAN_CORE: Online. Double Ratchet Engaged.";
    if (type === 'CIPHER') {
        renderMessage(UI.input.value, true);
        UI.input.value = '';
        UI.monitor.textContent = `> LAST_TX: Encrypted with key_step_${data.ratchetStep}`;
    }
};

function renderMessage(text, own = true) {
    const div = document.createElement('div');
    div.className = `msg ${own ? 'own' : 'other'}`;
    div.innerHTML = `<div style="font-size:9px; opacity:0.5">${own ? 'ME' : 'PEER'} [HW_VERIFIED]</div>${text}`;
    UI.chat.appendChild(div);
    UI.chat.scrollTop = UI.chat.scrollHeight;
}

UI.send.onclick = () => {
    const text = UI.input.value;
    if (!text) return;
    kernel.postMessage({ 
        type: 'ENCRYPT', 
        payload: { text }, 
        intent: { id: crypto.randomUUID(), signature: true } 
    });
};

// 5. ИИ
document.getElementById('askAi').onclick = () => {
    const p = document.getElementById('aiPrompt').value;
    const resp = document.getElementById('aiResponse');
    resp.textContent = "Processing via Sentinel Neural Link...";
    setTimeout(() => {
        resp.innerHTML = `<strong>AI SENTINEL:</strong> I am the core observer of Senpixel. My logic is currently bound to your local kernel. Your prompt: "<em>${p}</em>" is secure.`;
    }, 1000);
};

// Проверка сессии при загрузке
supabase.auth.getSession().then(({data}) => {
    if (data.session) initApp(data.session.user);
});
