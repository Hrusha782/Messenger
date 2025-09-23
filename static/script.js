// static/script.js
let ws = null;
let currentChatId = "";
let username = "";
let isTyping = false;
let typingTimer = null;
let pendingChatToLoad = null;
let editingMessageId = null;

// Берём имя пользователя из глобального window.appUsername, установленного в chat.html
username = window.appUsername || document.getElementById('current-username').textContent;

const chatBox = document.getElementById('chat');
const typingIndicator = document.getElementById('typing-indicator');
const inputArea = document.getElementById('input-area');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const friendCodeInput = document.getElementById('friend-code-input');
const friendResult = document.getElementById('friend-result');
let contextMenu = null;
let contextTargetChatId = null;
const msgContextMenu = document.getElementById('message-context-menu');
let contextTargetMessageId = null;
let groupSettings = {
    members: [],
};

async function loadUserChats() {
    try {
        const response = await fetch(`/api/user/chats?username=${encodeURIComponent(username)}`);
        const data = await response.json();

        const groupChatsList = document.getElementById('group-chats-list');
        const privateChatsList = document.getElementById('private-chats-list');
        
        // Очищаем списки
        groupChatsList.innerHTML = '';
        privateChatsList.innerHTML = '';

        // Групповые чаты
        if (data.group_chats.length === 0) {
            groupChatsList.innerHTML = '<p style="padding:10px; color:#666; font-size:12px;">Нет групповых чатов</p>';
        } else {
            data.group_chats.forEach(chat => {
                let chatItem = document.querySelector(`.chat-item[data-chat-id="${chat.chat_id}"]`);
                if (!chatItem) {
                    chatItem = document.createElement('div');
                    chatItem.className = 'chat-item';
                    groupChatsList.appendChild(chatItem);
                }
                chatItem.dataset.chatId = chat.chat_id;
                chatItem.innerHTML = `
                    👥 ${chat.name}
                    <span class="status-dot" style="float: right; width: 10px; height: 10px; border-radius: 50%; background: gray;"></span>
                `;

                // Если этот чат сейчас активен и в заголовке было временное имя — обновим его
                if (currentChatId === chat.chat_id) {
                    document.getElementById('chat-header').textContent = `👥 ${chat.name}`;
                }
            });
        }

        // Личные чаты
        if (data.private_chats.length === 0) {
            privateChatsList.innerHTML = '<p style="padding:10px; color:#666; font-size:12px;">Нет личных чатов</p>';
        } else {
            data.private_chats.forEach(chat => {
                let chatItem = document.querySelector(`.chat-item[data-chat-id="${chat.chat_id}"]`);
                if (!chatItem) {
                    chatItem = document.createElement('div');
                    chatItem.className = 'chat-item';
                    privateChatsList.appendChild(chatItem);
                }
                chatItem.dataset.chatId = chat.chat_id;
                chatItem.innerHTML = `
                    💬 С ${chat.name}
                    <span class="status-dot" style="float: right; width: 10px; height: 10px; border-radius: 50%; background: gray;"></span>
                `;

                if (currentChatId === chat.chat_id) {
                    document.getElementById('chat-header').textContent = `💬 С ${chat.name}`;
                }
            });
        }

    } catch (err) {
        console.error("Ошибка загрузки списка чатов:", err);
    }
}

function initChat() {
    const wsHost = window.location.host;
    ws = new WebSocket(`ws://${wsHost}/ws/${username}`);

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);

        const formatTime = (timestamp) => {
            return new Date(timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
            });
        };

        if (data.type === "history") {
            chatBox.innerHTML = '';
            
            if (!currentChatId) {
                chatBox.innerHTML = '<em>Выберите чат слева</em>';
                return;
            }

            if (data.messages.length === 0) {
                chatBox.innerHTML = '<em>В этом чате пока нет сообщений</em>';
                return;
            }

            data.messages.forEach(msg => {
                const row = renderMessageRow(msg);
                chatBox.appendChild(row);
            });
            chatBox.scrollTop = chatBox.scrollHeight;

        } else if (data.type === "message") {
            if (data.chat_id === currentChatId) {
                const row = renderMessageRow(data);
                chatBox.appendChild(row);
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        } else if (data.type === 'message_edited') {
            const el = document.querySelector(`[data-message-id="${data.message_id}"] .msg-text`);
            if (el) el.textContent = data.text;
            const container = document.querySelector(`[data-message-id="${data.message_id}"]`);
            if (container && !container.querySelector('.edited-mark')) {
                const mark = document.createElement('span');
                mark.className = 'edited-mark';
                mark.textContent = '(edited)';
                container.querySelector('p').appendChild(mark);
            }
            if (editingMessageId === String(data.message_id)) {
                // Exit edit mode if this was our edit
                editingMessageId = null;
                const input = document.getElementById('message');
                input.value = '';
                input.placeholder = 'Введите сообщение';
                document.getElementById('send').textContent = 'Отправить';
            }
        } else if (data.type === 'message_deleted') {
            const container = document.querySelector(`[data-message-id="${data.message_id}"]`);
            if (container && container.parentElement) container.parentElement.removeChild(container);
        } else if (data.type === "attachment") {
            if (data.chat_id === currentChatId) {
                const msg = {
                    id: data.id || '',
                    username: data.username,
                    timestamp: data.timestamp,
                    attachment: { url: data.url, filename: data.filename, is_image: data.is_image }
                };
                const row = renderMessageRow(msg);
                chatBox.appendChild(row);
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        } else if (data.type === "typing") {
            if (data.chat_id === currentChatId) {
                const users = data.users.filter(u => u !== username);
                if (users.length > 0) {
                    typingIndicator.textContent = `${users.join(', ')} печатает...`;
                    typingIndicator.style.display = 'block';
                } else {
                    typingIndicator.style.display = 'none';
                }
            }
        }
    };

    ws.onopen = function() {
        console.log("✅ WebSocket подключён");
        // Если пользователь выбрал чат до открытия сокета — загружаем его сейчас
        if (pendingChatToLoad) {
            ws.send(JSON.stringify({ type: "load_chat", chat_id: pendingChatToLoad }));
            pendingChatToLoad = null;
        }
    };

    ws.onerror = function(err) {
        console.error("❌ Ошибка WebSocket:", err);
    };

    const groupList = document.getElementById('group-chats-list');
    const privateList = document.getElementById('private-chats-list');
    contextMenu = document.getElementById('chat-context-menu');
    if (contextMenu) {
        contextMenu.oncontextmenu = (e) => e.preventDefault();
    }
    groupList.addEventListener('click', handleChatItemClick);
    privateList.addEventListener('click', handleChatItemClick);

    // Правый клик — контекстное меню
    const handleContext = (e) => {
        const item = e.target.closest('.chat-item');
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        contextTargetChatId = item.dataset.chatId;
        showContextMenu(e.clientX, e.clientY, contextTargetChatId);
    };
    if (groupList) groupList.addEventListener('contextmenu', handleContext);
    if (privateList) privateList.addEventListener('contextmenu', handleContext);

    // Перехватываем ПКМ на всём сайдбаре: скрываем системное меню всегда,
    // и показываем наше только для .chat-item
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            const item = e.target && e.target.closest ? e.target.closest('.chat-item') : null;
            if (item) {
                e.stopPropagation();
                contextTargetChatId = item.dataset.chatId;
                showContextMenu(e.clientX, e.clientY, contextTargetChatId);
            } else {
                hideContextMenu();
            }
        });
    }
}

function handleChatItemClick(e) {
    if (e.target.classList.contains('chat-item') || e.target.closest('.chat-item')) {
        const chatItem = e.target.closest('.chat-item');
        const chatId = chatItem.dataset.chatId;
        if (chatId) {
            loadChat(chatId);
        }
    }
}

function sendMessage() {
    const input = document.getElementById('message');
    const text = input.value.trim();
    if (!text || !ws || !currentChatId) return;

    if (editingMessageId) {
        ws.send(JSON.stringify({ type: 'edit_message', message_id: editingMessageId, text }));
    } else {
        ws.send(JSON.stringify({ text, chat_id: currentChatId }));
    }
    input.value = '';
    input.placeholder = 'Введите сообщение';
    document.getElementById('send').textContent = 'Отправить';
    editingMessageId = null;

    if (isTyping) {
        ws.send(JSON.stringify({
            type: "typing",
            chat_id: currentChatId,
            is_typing: false
        }));
        isTyping = false;
    }
}

// ✅ Исправленная функция loadChat — создаёт элемент вручную, если его нет
function loadChat(chatId) {
    currentChatId = chatId;

    const header = document.getElementById('chat-header');
    const groupChatsList = document.getElementById('group-chats-list');

    if (chatId.startsWith("group:")) {
        let chatItem = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
        
        // ✅ Если элемента нет — создаём его вручную
        if (!chatItem) {
            // Используем переданное имя группы для красивой загрузки
            let groupName = window.__pendingGroupName || "Без названия";
            chatItem = document.createElement('div');
            chatItem.className = 'chat-item';
            chatItem.dataset.chatId = chatId;
            chatItem.innerHTML = `
                👥 ${groupName}
                <span class="status-dot" style="float: right; width: 10px; height: 10px; border-radius: 50%; background: gray;"></span>
            `;
            groupChatsList.appendChild(chatItem);
        }

        const fullText = chatItem.textContent.trim();
        const cleanText = fullText.replace(/\s*●\s*$/, '');
        header.textContent = cleanText;
    } else {
        const otherUser = chatId.replace(username + ":", "").replace(":" + username, "");
        header.textContent = `💬 С ${otherUser}`;
    }

    // Подсвечиваем активный чат
    document.querySelectorAll('.chat-item').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.chatId === chatId) {
            el.classList.add('active');
        }
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "load_chat", chat_id: chatId }));
    } else {
        pendingChatToLoad = chatId;
    }

    chatBox.innerHTML = '<em>Загрузка...</em>';
    typingIndicator.style.display = 'none';
    inputArea.style.display = 'flex';

    setTimeout(() => {
        document.getElementById('message').focus();
    }, 100);
}

async function addFriendByCode() {
    const code = friendCodeInput.value.trim().toUpperCase();
    if (!code) {
        showFriendResult("Введите код друга", false);
        return;
    }

    friendResult.style.display = 'block';
    friendResult.textContent = "Добавление...";
    friendResult.className = "result";

    try {
        const response = await fetch('/api/add_friend', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                friend_code: code,
                username: username
            })
        });

        const result = await response.json();

        if (result.error) {
            showFriendResult(result.error, false);
        } else {
            showFriendResult(`✅ Друг ${result.friend} добавлен!`, true);
            friendCodeInput.value = '';
            loadUserChats();
        }
    } catch (err) {
        console.error("Ошибка:", err);
        showFriendResult("Ошибка сети", false);
    }
}

function showFriendResult(message, isSuccess) {
    friendResult.textContent = message;
    friendResult.className = isSuccess ? "result success" : "result error";
}

document.getElementById('message').addEventListener('input', function() {
    if (!ws || !currentChatId) return;

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
    
    const hash = window.location.hash.substring(1);
    if (hash) {
        // Плавная загрузка: сначала отображаем заголовок с именем, затем подгружаем список
        loadChat(hash);
        // Перезагружаем список чатов, чтобы подтянулось настоящее имя из БД
        setTimeout(() => { loadUserChats(); }, 400);
        setTimeout(() => { loadUserChats(); }, 1200);
    } else {
        // Приветственное состояние, если чат не выбран
        currentChatId = '';
        document.getElementById('chat-header').textContent = 'Добро пожаловать в мессенджер';
        chatBox.innerHTML = '<p>Выберите чат слева или создайте новый групповой чат.</p>';
        inputArea.style.display = 'none';
        // Сбрасываем временное имя группы, чтобы не залипало "Без названия"
        window.__pendingGroupName = null;
    }

    initChat();

    document.getElementById('message').addEventListener('keydown', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            sendMessage();
        }
    });

    document.getElementById('send').addEventListener('click', sendMessage);

    // Прикрепление файлов
    if (attachBtn && fileInput) {
        attachBtn.addEventListener('click', () => {
            if (!currentChatId) return;
            fileInput.value = '';
            fileInput.click();
        });
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file || !currentChatId) return;
            try {
                const form = new FormData();
                form.append('username', username);
                form.append('chat_id', currentChatId);
                form.append('file', file);
                const resp = await fetch('/api/upload', { method: 'POST', body: form });
                const result = await resp.json();
                if (result && result.success) {
                    // Отправляем событие вложения по WebSocket для всех клиентов
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'attachment',
                            chat_id: currentChatId,
                            url: result.url,
                            filename: result.filename,
                            is_image: result.is_image
                        }));
                    }
                }
            } catch (e) {
                console.error('Upload failed', e);
            }
        });
    }

    // Глобальные обработчики для контекстного меню
    // Скрываем меню только при ЛКМ вне меню
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
    });
    window.addEventListener('scroll', () => hideContextMenu(), true);
    window.addEventListener('resize', () => hideContextMenu());
    if (contextMenu) contextMenu.addEventListener('click', onContextMenuClick);

    // Message context menu
    chatBox.addEventListener('contextmenu', function(e) {
        const item = e.target.closest('[data-message-id]');
        if (item) {
            e.preventDefault();
            e.stopPropagation();
            contextTargetMessageId = item.dataset.messageId;
            showMsgContextMenu(e.clientX, e.clientY);
        } else {
            hideMsgContextMenu();
        }
    });
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (msgContextMenu && !msgContextMenu.contains(e.target)) hideMsgContextMenu();
    });
    if (msgContextMenu) msgContextMenu.addEventListener('click', onMsgContextClick);

    // Глобальный перехватчик ПКМ: показывает наше меню для элементов .chat-item
    document.addEventListener('contextmenu', function(e) {
        const item = e.target && e.target.closest ? e.target.closest('.chat-item') : null;
        if (item) {
            e.preventDefault();
            e.stopPropagation();
            contextTargetChatId = item.dataset.chatId;
            showContextMenu(e.clientX, e.clientY, contextTargetChatId);
        } else {
            hideContextMenu();
        }
    }, true);
});

async function openGroupSettings(chatId) {
    try {
        const resp = await fetch(`/api/group_info?chat_id=${encodeURIComponent(chatId)}`);
        const info = await resp.json();
        groupSettings.members = Array.isArray(info.participants) ? info.participants.slice() : [];
        renderGroupMembers();
        const modal = document.getElementById('group-settings-modal');
        modal.style.display = 'flex';

        document.getElementById('group-settings-cancel').onclick = () => { modal.style.display = 'none'; };
        // removed add-by-username input handler
        document.getElementById('group-settings-save').onclick = async () => {
            await saveGroupMembers(chatId);
            modal.style.display = 'none';
            loadUserChats();
        };
    } catch (e) {
        console.error('Failed to open group settings', e);
    }
}

function renderGroupMembers() {
    const container = document.getElementById('group-members-container');
    container.innerHTML = '';
    groupSettings.members.forEach(u => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.padding = '6px 4px';
        const name = document.createElement('span');
        name.textContent = u;
        // кнопка удаления участника (не показываем для себя)
        if (u !== username) {
            const removeBtn = document.createElement('button');
            removeBtn.textContent = 'Удалить';
            removeBtn.className = 'btn btn-danger';
            removeBtn.onclick = () => {
                groupSettings.members = groupSettings.members.filter(x => x !== u);
                renderGroupMembers();
            };
            row.appendChild(name);
            row.appendChild(removeBtn);
        } else {
            row.appendChild(name);
        }
        container.appendChild(row);
    });
}

async function saveGroupMembers(chatId) {
    try {
        const form = new URLSearchParams();
        form.append('chat_id', chatId);
        form.append('members', groupSettings.members.join(', '));
        form.append('actor', username);
        const resp = await fetch('/api/group_update_members', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form
        });
        const res = await resp.json();
        if (!res.success) {
            console.error('Failed to save group members', res);
        }
    } catch (e) {
        console.error('Failed to save group members', e);
    }
}

// Enhance modal controls for adding by code / from friends and leaving group
document.addEventListener('DOMContentLoaded', () => {
    const addByCodeBtn = document.getElementById('add-by-code-btn');
    const addByCodeInput = document.getElementById('add-by-code-input');
    const addFromFriendsBtn = document.getElementById('add-from-friends-btn');
    const friendsPicker = document.getElementById('friends-picker');
    const leaveBtn = document.getElementById('group-leave-btn');

    if (addByCodeBtn && addByCodeInput) {
        addByCodeBtn.addEventListener('click', async () => {
            const code = (addByCodeInput.value || '').trim().toUpperCase();
            if (!code) return;
            try {
                const resp = await fetch(`/api/resolve_friend_code?code=${encodeURIComponent(code)}`);
                const res = await resp.json();
                if (res.found && res.username) {
                    if (!groupSettings.members.includes(res.username)) {
                        groupSettings.members.push(res.username);
                        renderGroupMembers();
                    }
                }
            } catch (e) { console.error('resolve code failed', e); }
            addByCodeInput.value = '';
        });
    }

    if (addFromFriendsBtn && friendsPicker) {
        addFromFriendsBtn.addEventListener('click', async () => {
            friendsPicker.style.display = friendsPicker.style.display === 'none' ? 'block' : 'none';
            if (friendsPicker.dataset.loaded === '1') return;
            try {
                const resp = await fetch(`/api/friends_list?username=${encodeURIComponent(username)}`);
                const data = await resp.json();
                friendsPicker.innerHTML = '';
                (data.friends || []).forEach(f => {
                    const btn = document.createElement('button');
                    btn.textContent = f.username;
                    btn.className = 'btn';
                    btn.style.margin = '4px';
                    btn.onclick = () => {
                        if (!groupSettings.members.includes(f.username)) {
                            groupSettings.members.push(f.username);
                            renderGroupMembers();
                        }
                    };
                    friendsPicker.appendChild(btn);
                });
                friendsPicker.dataset.loaded = '1';
            } catch (e) { console.error('friends load failed', e); }
        });
    }

    if (leaveBtn) {
        leaveBtn.addEventListener('click', async () => {
            if (!contextTargetChatId || !contextTargetChatId.startsWith('group:')) return;
            try {
                const resp = await fetch('/api/group_leave', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ chat_id: contextTargetChatId, username })
                });
                const res = await resp.json();
                document.getElementById('group-settings-modal').style.display = 'none';
                // If chat deleted or user left, update UI
                if (res.chat_deleted || (res.success && res.participants && !res.participants.includes(username))) {
                    // remove chat from list and reset view
                    const el = document.querySelector(`.chat-item[data-chat-id="${contextTargetChatId}"]`);
                    if (el && el.parentElement) el.parentElement.removeChild(el);
                    if (currentChatId === contextTargetChatId) {
                        currentChatId = '';
                        document.getElementById('chat-header').textContent = 'Выберите чат';
                        chatBox.innerHTML = '<em>Выберите чат слева</em>';
                        inputArea.style.display = 'none';
                    }
                    loadUserChats();
                }
            } catch (e) { console.error('leave failed', e); }
        });
    }
});

function showContextMenu(x, y, chatId) {
    if (!contextMenu) return;
    const isPrivate = !chatId.startsWith('group:');
    const removeFriendItem = contextMenu.querySelector('[data-action="remove-friend"]');
    removeFriendItem.style.display = isPrivate ? 'block' : 'none';
    const groupSettingsItem = contextMenu.querySelector('[data-action="group-settings"]');
    if (groupSettingsItem) groupSettingsItem.style.display = isPrivate ? 'none' : 'block';

    // Позиционирование внутри видимой области
    contextMenu.style.display = 'block';
    const menuRect = contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - menuRect.width - 8;
    const maxY = window.innerHeight - menuRect.height - 8;
    const posX = Math.max(8, Math.min(x, maxX));
    const posY = Math.max(8, Math.min(y, maxY));
    contextMenu.style.left = posX + 'px';
    contextMenu.style.top = posY + 'px';
}

function hideContextMenu() {
    if (!contextMenu) return;
    contextMenu.style.display = 'none';
}

function showMsgContextMenu(x, y) {
    if (!msgContextMenu) return;
    msgContextMenu.style.display = 'block';
    const rect = msgContextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    msgContextMenu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    msgContextMenu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
}

function hideMsgContextMenu() {
    if (!msgContextMenu) return;
    msgContextMenu.style.display = 'none';
}

function onMsgContextClick(e) {
    const action = e.target.getAttribute('data-action');
    if (!action || !contextTargetMessageId) return;
    if (action === 'delete') {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'delete_message', message_id: contextTargetMessageId }));
        }
    } else if (action === 'edit') {
        const row = document.querySelector(`[data-message-id="${contextTargetMessageId}"]`);
        if (row) {
            const span = row.querySelector('.msg-text');
            const current = span ? span.textContent : '';
            const input = document.getElementById('message');
            input.value = current;
            input.placeholder = 'Редактировать сообщение';
            document.getElementById('send').textContent = 'Сохранить';
            editingMessageId = String(contextTargetMessageId);
            // Устанавливаем курсор в конец текста и фокусируем поле
            setTimeout(() => {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }, 0);
        }
    }
    hideMsgContextMenu();
}

function renderMessageRow(msg) {
    const row = document.createElement('div');
    row.dataset.messageId = msg.id || '';
    const p = document.createElement('p');
    const time = new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const name = document.createElement('strong');
    name.textContent = msg.username + ' ';
    const meta = document.createElement('span');
    meta.textContent = `(${time}): `;
    p.appendChild(name);
    p.appendChild(meta);

    if (msg.attachment) {
        const label = document.createElement('span');
        label.textContent = '';
        p.appendChild(label);
        row.appendChild(p);
        if (msg.attachment.is_image) {
            const img = document.createElement('img');
            img.src = msg.attachment.url;
            img.alt = msg.attachment.filename || '';
            img.style.maxWidth = '280px';
            img.style.borderRadius = '6px';
            img.style.display = 'block';
            img.style.marginTop = '4px';
            row.appendChild(img);
        } else {
            const a = document.createElement('a');
            a.href = msg.attachment.url;
            a.textContent = `📎 ${msg.attachment.filename || 'файл'}`;
            a.target = '_blank';
            a.rel = 'noopener';
            row.appendChild(a);
        }
    } else {
        const textSpan = document.createElement('span');
        textSpan.className = 'msg-text';
        textSpan.textContent = msg.text;
        p.appendChild(textSpan);
        if (msg.edited) {
            const mark = document.createElement('span');
            mark.className = 'edited-mark';
            mark.textContent = '(edited)';
            p.appendChild(mark);
        }
        row.appendChild(p);
    }
    return row;
}

async function onContextMenuClick(e) {
    const action = e.target.getAttribute('data-action');
    if (!action || !contextTargetChatId) return;

    if (action === 'open') {
        loadChat(contextTargetChatId);
    }

    if (action === 'delete-chat') {
        await deleteChat(contextTargetChatId);
    }

    if (action === 'remove-friend') {
        const otherUser = contextTargetChatId.replace(username + ":", "").replace(":" + username, "");
        await removeFriend(otherUser);
    }

    if (action === 'group-settings') {
        await openGroupSettings(contextTargetChatId);
        return; // не скрываем сразу, т.к. открываем модалку
    }

    hideContextMenu();
}

async function deleteChat(chatId) {
    try {
        const resp = await fetch('/api/delete_chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ chat_id: chatId })
        });
        const res = await resp.json();
        if (res.success) {
            // Если удаляем текущий чат — очищаем окно
            if (currentChatId === chatId) {
                currentChatId = '';
                document.getElementById('chat-header').textContent = 'Выберите чат';
                chatBox.innerHTML = '<em>Выберите чат слева</em>';
                inputArea.style.display = 'none';
            }
            // Удаляем элемент из списка
            const el = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
            if (el && el.parentElement) el.parentElement.removeChild(el);

            // Показываем заглушки, если списки пустые
            const groupChatsList = document.getElementById('group-chats-list');
            const privateChatsList = document.getElementById('private-chats-list');
            if (groupChatsList && groupChatsList.querySelectorAll('.chat-item').length === 0) {
                groupChatsList.innerHTML = '<p style="padding:10px; color:#666; font-size:12px;">Нет групповых чатов</p>';
            }
            if (privateChatsList && privateChatsList.querySelectorAll('.chat-item').length === 0) {
                privateChatsList.innerHTML = '<p style="padding:10px; color:#666; font-size:12px;">Нет личных чатов</p>';
            }

            // Дополнительно обновим список с сервера
            loadUserChats();
        }
    } catch (err) {
        console.error('Не удалось удалить чат', err);
    }
}

async function removeFriend(friendUsername) {
    try {
        const resp = await fetch('/api/remove_friend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: username, friend_username: friendUsername })
        });
        const res = await resp.json();
        if (res.success) {
            // Удаляем личный чат из списка, если есть
            const el = document.querySelector(`.chat-item[data-chat-id="${res.chat_id}"]`);
            if (el && el.parentElement) el.parentElement.removeChild(el);
            if (currentChatId === res.chat_id) {
                currentChatId = '';
                document.getElementById('chat-header').textContent = 'Выберите чат';
                chatBox.innerHTML = '<em>Выберите чат слева</em>';
                inputArea.style.display = 'none';
            }

            // Показываем заглушки, если личных чатов не осталось
            const privateChatsList = document.getElementById('private-chats-list');
            if (privateChatsList && privateChatsList.querySelectorAll('.chat-item').length === 0) {
                privateChatsList.innerHTML = '<p style="padding:10px; color:#666; font-size:12px;">Нет личных чатов</p>';
            }

            loadUserChats();
        }
    } catch (err) {
        console.error('Не удалось удалить друга', err);
    }
}