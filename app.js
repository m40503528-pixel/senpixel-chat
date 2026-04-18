const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const http = require('http');

// --- КЛЮЧИ (твои) ---
const SUPABASE_URL = 'https://kwotdvdjxhpttuwhgjkh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_i6HL03F98ZmxCKmAKQDaLQ_w6u7ep4d';
const GROQ_API_KEY = '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';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Сервер-заглушка, чтобы Render не убил процесс (Health Check)
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TITAN CLOUD IS ONLINE');
}).listen(process.env.PORT || 3000);

let isProcessing = false;

async function titanCloudCycle() {
    if (isProcessing) return;

    try {
        // 1. Ищем задачу
        const { data: tasks, error: tErr } = await supabase.from('titan_tasks')
            .select('*').eq('status', 'pending').limit(1);

        if (tErr || !tasks?.length) return;
        
        isProcessing = true;
        const task = tasks[0];
        const timestamp = new Date().toLocaleTimeString();
        console.log(`\n[${timestamp}] 🚀 Принята задача: ${task.title}`);

        // 2. Берем текущий сайт
        const { data: site } = await supabase.from('site_data').select('html_content').eq('id', 1).single();
        const oldCode = site?.html_content || "";

        // 3. Отправляем в МОЗГ (70 миллиардов параметров!)
        console.log(`[${timestamp}] 🧠 Думает Llama-3 (70B)...`);
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", // Самая мощная модель Groq!
            messages: [
                { 
                    role: "system", 
                    content: "You are a Senior UI/UX Web Developer. You receive an HTML file and a task. You MUST return ONLY the updated, valid, raw HTML code. Do NOT wrap the code in ```html markdown blocks. Do NOT output any explanations or conversational text. Output raw code starting with <!DOCTYPE html>." 
                },
                { 
                    role: "user", 
                    content: `Task to implement: ${task.description}\n\nCurrent HTML code:\n${oldCode}` 
                }
            ],
            temperature: 0.1 // Делаем его строгим и логичным
        }, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
        });

        let newCode = response.data.choices[0].message.content.trim();

        // Защита от маркдауна (если ИИ все-таки добавит ```html)
        if (newCode.startsWith('```')) {
            newCode = newCode.replace(/^```html\n?|```$/g, '').trim();
        }

        // 4. Проверка на целостность перед записью
        if (newCode.length > 200 && newCode.includes('<html') && newCode.includes('</body>')) {
            const { error: upErr } = await supabase.from('site_data').update({ html_content: newCode }).eq('id', 1);
            if (upErr) throw upErr;

            await supabase.from('titan_tasks').update({ status: 'completed' }).eq('id', task.id);
            console.log(`[${timestamp}] ✅ Код успешно внедрен в базу!`);
        } else {
            console.error(`[${timestamp}] ❌ Критическая ошибка ИИ: Выдан некорректный код. Отмена патча.`);
            // Если ИИ сломался, просто меняем статус задачи на failed, чтобы не зависать
            await supabase.from('titan_tasks').update({ status: 'failed' }).eq('id', task.id);
        }

    } catch (err) {
        console.error(`[ERROR]: ${err.message}`);
    } finally {
        isProcessing = false;
    }
}

// Пингуем базу каждые 5 секунд (в облаке это бесплатно и быстро)
setInterval(titanCloudCycle, 5000);
console.log('==========================================');
console.log(' TITAN CLOUD v20.0 | LLAMA-3 70B ACTIVE ');
console.log('==========================================');