// static/script.js
let ws = null;
let currentChatId = "global";
let username = "";
let isTyping = false;
let typingTimer = null;

username = document.getElementById('current-username').textContent;

async function loadUserChats() {
    try {
        const response = await fetch(`/api/user/chats?username=${encodeURIComponent(username)}`);
        const data = await response.json();

        const chatList = document.getElementById('chat-list');
        while (chatList.children.length > 1) {
            chatList.removeChild(chatList.lastChild);
        }

        data.chats.forEach(chat => {
            if (chat.chat_id === "global") return;

            let chatItem = document.querySelector(`.chat-item[data-chat-id="${chat.chat_id}"]`);
            if (!chatItem) {
                chatItem = document.createElement('div');
                chatItem.className = 'chat-item';
                chatItem.dataset.chatId = chat.chat_id;
                chatItem.innerHTML = `
                    ${chat.name}
                    <span class="status-dot" style="float: right; width: 10px; height: 10px; border-radius: 50%; background: gray;"></span>
                `;
                chatList.appendChild(chatItem);
            }
        });

    } catch (err) {
        console.error("Ошибка загрузки списка чатов:", err);
    }
}

function initChat() {
    const wsHost = window.location.host;
    ws = new WebSocket(`ws://${wsHost}/ws/${username}`);

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        const chatBox = document.getElementById('chat');
        const typingIndicator = document.getElementById('typing-indicator');

        const formatTime = (timestamp) => {
            return new Date(timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        };

        if (data.type === "history") {
            chatBox.innerHTML = '';
            data.messages.forEach(msg => {
                const p = document.createElement('p');
                p.innerHTML = `<strong>${msg.username}</strong> (${formatTime(msg.timestamp)}): ${msg.text}`;
                chatBox.appendChild(p);
            });
            chatBox.scrollTop = chatBox.scrollHeight;

        } else if (data.type === "message") {
            if (data.chat_id === currentChatId) {
                const p = document.createElement('p');
                p.innerHTML = `<strong>${data.username}</strong> (${formatTime(data.timestamp)}): ${data.text}`;
                chatBox.appendChild(p);
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        } else if (data.type === "typing") {
            if (data.chat_id === currentChatId) {
                const users = data.users.filter(u => u !== username);
                if (users.length > 0) {
                    typingIndicator.textContent = `${users.join(', ')} печатает...`;
                } else {
                    typingIndicator.textContent = "Никто не печатает...";
                }
            }
        }
    };

    ws.onopen = function() {
        console.log("✅ WebSocket подключён");
        loadChat("global");
    };

    ws.onerror = function(err) {
        console.error("❌ Ошибка WebSocket:", err);
    };

    document.getElementById('chat').addEventListener('click', function(e) {
        if (e.target.tagName === 'STRONG') {
            const clickedUsername = e.target.textContent;
            if (clickedUsername !== username) {
                const chatId = [username, clickedUsername].sort().join(":");
                let chatItem = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
                if (!chatItem) {
                    chatItem = document.createElement('div');
                    chatItem.className = 'chat-item';
                    chatItem.dataset.chatId = chatId;
                    chatItem.innerHTML = `
                        💬 С ${clickedUsername}
                        <span class="status-dot" style="float: right; width: 10px; height: 10px; border-radius: 50%; background: gray;"></span>
                    `;
                    document.getElementById('chat-list').appendChild(chatItem);
                }
                loadChat(chatId);
            }
        }
    });

    document.getElementById('chat-list').addEventListener('click', function(e) {
        if (e.target.classList.contains('chat-item') || e.target.closest('.chat-item')) {
            const chatItem = e.target.closest('.chat-item');
            const chatId = chatItem.dataset.chatId;
            if (chatId) {
                loadChat(chatId);
            }
        }
    });
}

function sendMessage() {
    const input = document.getElementById('message');
    const text = input.value.trim();
    if (!text || !ws) return;

    ws.send(JSON.stringify({
        text: text,
        chat_id: currentChatId
    }));
    input.value = '';

    if (isTyping) {
        ws.send(JSON.stringify({
            type: "typing",
            chat_id: currentChatId,
            is_typing: false
        }));
        isTyping = false;
    }
}

function loadChat(chatId) {
    currentChatId = chatId;

    const header = document.getElementById('chat-header');
    if (chatId === "global") {
        header.textContent = "👥 Общий чат";
    } else {
        const otherUser = chatId.replace(username + ":", "").replace(":" + username, "");
        header.textContent = `💬 С ${otherUser}`;
    }

    document.querySelectorAll('.chat-item').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.chatId === chatId) {
            el.classList.add('active');
        }
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "load_chat",
            chat_id: chatId
        }));
    }

    document.getElementById('chat').innerHTML = '<em>Загрузка...</em>';
    document.getElementById('typing-indicator').textContent = "Никто не печатает...";
}

document.getElementById('message').addEventListener('input', function() {
    if (!ws) return;

    if (!isTyping) {
        isTyping = true;
        ws.send(JSON.stringify({
            type: "typing",
            chat_id: currentChatId,
            is_typing: true
        }));
    }

    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        if (isTyping) {
            ws.send(JSON.stringify({
                type: "typing",
                chat_id: currentChatId,
                is_typing: false
            }));
            isTyping = false;
        }
    }, 2000);
});

document.addEventListener('DOMContentLoaded', function() {
    loadUserChats();
    initChat();

    document.getElementById('message').addEventListener('keydown', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            sendMessage();
        }
    });

    document.getElementById('send').addEventListener('click', sendMessage);
});