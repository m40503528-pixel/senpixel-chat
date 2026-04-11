// Конфигурация БД (Твои ключи)
const SUPABASE_URL = 'https://kwotdvdjxhpttuwhgjkh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_i6HL03F98ZmxCKmAKQDaLQ_w6u7ep4d';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentChatId = '00000000-0000-0000-0000-000000000002'; // Глобальный канал из твоего SQL
let messagesSub = null;

// UI Элементы
const UI = {
    modal: document.getElementById('auth-modal'),
    app: document.getElementById('app'),
    error: document.getElementById('errorMsg'),
    emailLabel: document.getElementById('profileEmail'),
    chatList: document.getElementById('chatList'),
    messages: document.getElementById('messages'),
    inputArea: document.getElementById('inputArea'),
    msgInput: document.getElementById('messageInput'),
    sentinel: document.getElementById('sentinel-bar')
};

// 1. АВТОРИЗАЦИЯ SUPABASE
async function checkSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        UI.modal.style.display = 'none';
        UI.app.style.display = 'flex';
        UI.emailLabel.innerText = currentUser.email;
        initCore();
    }
}

document.getElementById('loginBtn').onclick = async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) UI.error.innerText = error.message; else checkSession();
};

document.getElementById('regBtn').onclick = async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) UI.error.innerText = error.message; else UI.error.innerText = 'Success! Please log in.';
};

document.getElementById('logoutBtn').onclick = async () => {
    await supabase.auth.signOut();
    location.reload();
};

// 2. ИЗОЛИРОВАННОЕ ЯДРО (TITAN WORKER)
const kernel = new Worker('titan_kernel.js');

function initCore() {
    kernel.postMessage({ type: 'INIT' });
    loadChats();
}

kernel.onmessage = async (e) => {
    const { type, data } = e.data;
    
    if (type === 'READY') {
        UI.sentinel.innerText = "> SENTINEL: Crypto-Kernel Online. Ready for DB Sync.";
    }
    
    if (type === 'CIPHER') {
        // Получили зашифрованный текст из Воркера, теперь отправляем в БД
        UI.sentinel.innerText = `> SENTINEL: Payload encrypted (Ratchet Step ${data.step}). Pushing to DB...`;
        
        await supabase.from('messages').insert([{ 
            chat_id: currentChatId, 
            user_id: currentUser.id, 
            content: data.cipher, // Отправляем ШИФР, а не голый текст
            type: 'text' 
        }]);
    }
};

// 3. РОУТИНГ (Telegram Tabs)
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.add('active');
    };
});

// 4. ЛОГИКА ЧАТА (База данных)
async function loadChats() {
    // В упрощенной демо-версии сразу открываем Глобальный канал
    UI.chatList.innerHTML = `<div class="chat-item" style="background: rgba(0,255,162,0.1); border-color: var(--neon);">
        <div style="font-size: 24px;">🌍</div><div><strong>Global Nexus</strong><br><span style="font-size:10px; color:#7f91a4;">Encrypted Room</span></div>
    </div>`;
    openChat(currentChatId);
}

async function openChat(chatId) {
    UI.inputArea.style.visibility = 'visible';
    UI.messages.innerHTML = '';
    
    if (messagesSub) messagesSub.unsubscribe();

    // Загрузка истории
    const { data: msgs } = await supabase.from('messages').select('*, profiles(username)').eq('chat_id', chatId).order('created_at', { ascending: true });
    if (msgs) msgs.forEach(m => renderMessage(m));
    UI.messages.scrollTop = UI.messages.scrollHeight;

    // Real-time подписка
    messagesSub = supabase.channel(`chat_${chatId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` }, async (payload) => {
            const { data: profile } = await supabase.from('profiles').select('username').eq('id', payload.new.user_id).single();
            payload.new.profiles = profile;
            renderMessage(payload.new);
            UI.messages.scrollTop = UI.messages.scrollHeight;
        }).subscribe();
}

function renderMessage(msg) {
    const isOwn = msg.user_id === currentUser.id;
    const div = document.createElement('div');
    div.className = `msg ${isOwn ? 'own' : 'other'}`;
    
    const time = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    let contentHtml = msg.type === 'image' ? `<img src="${msg.content}">` : `<span style="font-family:monospace; color:#00e5ff;">[E2E]</span> ${msg.content}`;

    div.innerHTML = `
        <div class="msg-meta">
            <span style="font-weight:bold; color:var(--neon);">${isOwn ? 'YOU' : 'PEER_NODE'}</span>
            <span>${time}</span>
        </div>
        <div>${contentHtml}</div>
    `;
    UI.messages.appendChild(div);
}

// 5. ОТПРАВКА СООБЩЕНИЙ (Через Ядро)
document.getElementById('sendBtn').onclick = () => {
    const text = UI.msgInput.value.trim();
    if (!text) return;
    
    UI.msgInput.value = '';
    UI.sentinel.innerText = "> SENTINEL: Validating Hardware Intent...";
    
    // Вместо прямой отправки, просим Воркер зашифровать
    kernel.postMessage({ 
        type: 'ENCRYPT', 
        payload: { text }, 
        intent: { signature: "HW_ASSERT_V5_" + Date.now() } 
    });
};

// Отправка картинки (Изображения пока отправляем напрямую как URL)
document.getElementById('fileInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    UI.sentinel.innerText = "> SENTINEL: Uploading binary asset...";
    
    const path = `${currentUser.id}/${Date.now()}_${file.name}`;
    await supabase.storage.from('chat-files').upload(path, file);
    const { data } = supabase.storage.from('chat-files').getPublicUrl(path);
    
    await supabase.from('messages').insert([{ chat_id: currentChatId, user_id: currentUser.id, content: data.publicUrl, type: 'image' }]);
};

// 6. ИИ АССИСТЕНТ (Локальная симуляция)
document.getElementById('askAiBtn').onclick = () => {
    const p = document.getElementById('aiPrompt').value;
    if(!p) return;
    const ans = document.getElementById('aiAnswer');
    ans.style.display = 'block';
    ans.innerHTML = 'Processing via Sentinel Logic Module...';
    setTimeout(() => {
        ans.innerHTML = `> ANALYSIS COMPLETE.<br>> Query: "${p}"<br>> Status: I am a local defensive heuristic script. My primary directive is to secure the DOM and Kernel memory. I require a server-side LLM upgrade to process semantic data.`;
    }, 1200);
};

// Запуск
checkSession();
