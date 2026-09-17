/* =============================================================================
   Nyxo — клиентская логика.

   Контракт с сервером не меняется: те же REST-пути и поля, те же события
   socket.io, тот же CSRF (кука csrf_token -> заголовок X-CSRF-Token).

   Два сквозных правила по всему файлу:
   1. Никакого innerHTML для текста от пользователя или сервера. Весь DOM
      собирается через createElement/textContent — одна техника везде,
      поэтому отдельная функция экранирования больше не нужна.
   2. Никаких инлайновых обработчиков — только addEventListener (CSP
      script-src без 'unsafe-inline').
   ========================================================================== */

const socket = io();

let currentChatId = null;
let currentRoomId = null;
let currentUser = null;
let replyToMessageId = null;
let editingMessageId = null;
let longPressTimer = null;

/* Служебное состояние UI (на сервер не влияет) */
let chatsLoadedOnce = false;
let chatLoadToken = 0;
let menuOpenedAt = 0;
let toastTimers = [];
let lastFocusedBeforeModal = null;
const modalCloseTimers = new Map();

/* Палитра аватаров. Те же шесть значений лежат в color-picker (index.html)
   и в --avatar-1..6 (style.css). Меняется в трёх местах одинаково. */
const AVATAR_FALLBACK = '#E8B04B';

const SVG_NS = 'http://www.w3.org/2000/svg';

const elements = {
    authScreen: document.getElementById('auth-screen'),
    app: document.getElementById('app'),
    sidebar: document.querySelector('.sidebar'),
    mainContent: document.querySelector('.main-content'),
    authTabs: document.querySelector('.auth-tabs'),
    loginForm: document.getElementById('login-form'),
    registerForm: document.getElementById('register-form'),
    loginBtn: document.getElementById('login-btn'),
    registerBtn: document.getElementById('register-btn'),
    anonymousLoginBtn: document.getElementById('anonymous-login-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    chatsList: document.getElementById('chats-list'),
    chatMessages: document.getElementById('chat-messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
    recordBtn: document.getElementById('record-btn'),
    newChatBtn: document.getElementById('new-chat-btn'),
    backToListBtn: document.getElementById('back-to-list-btn'),
    chatHeader: document.getElementById('chat-header'),
    chatName: document.getElementById('chat-name'),
    chatStatus: document.getElementById('chat-status'),
    chatAvatar: document.getElementById('chat-avatar'),
    emptyState: document.getElementById('empty-state'),
    emptyStatePick: document.getElementById('empty-state-pick'),
    emptyStateFirst: document.getElementById('empty-state-first'),
    emptyNewChatBtn: document.getElementById('empty-new-chat-btn'),
    messageInputContainer: document.getElementById('message-input-container'),
    searchInput: document.getElementById('search-input'),
    newChatModal: document.getElementById('new-chat-modal'),
    chatMenuModal: document.getElementById('chat-menu-modal'),
    profileModal: document.getElementById('profile-modal'),
    passwordModal: document.getElementById('password-modal'),
    inviteModal: document.getElementById('invite-modal'),
    createChatBtn: document.getElementById('create-chat-btn'),
    joinChatBtn: document.getElementById('join-chat-btn'),
    deleteChatBtn: document.getElementById('delete-chat-btn'),
    getChatCodeBtn: document.getElementById('get-chat-code-btn'),
    chatMenuBtn: document.getElementById('chat-menu-btn'),
    profileBtn: document.getElementById('profile-btn'),
    changePasswordBtn: document.getElementById('change-password-btn'),
    savePasswordBtn: document.getElementById('save-password-btn'),
    inviteCodeDisplay: document.getElementById('invite-code-display'),
    copyInviteBtn: document.getElementById('copy-invite-btn'),
    messageMenu: document.getElementById('message-menu'),
    replyMessageBtn: document.getElementById('reply-message-btn'),
    editMessageBtn: document.getElementById('edit-message-btn'),
    deleteMessageBtn: document.getElementById('delete-message-btn'),
    replyPreview: document.getElementById('reply-preview'),
    replyPreviewText: document.getElementById('reply-preview-text'),
    composerContextKind: document.getElementById('composer-context-kind'),
    cancelReplyBtn: document.getElementById('cancel-reply-btn'),
    toast: document.getElementById('toast'),
    overlay: document.getElementById('overlay'),
    profileUsername: document.getElementById('profile-username'),
    profileEmail: document.getElementById('profile-email'),
    profileCode: document.getElementById('profile-code'),
    profileAvatar: document.getElementById('profile-avatar'),
    profileAnonBadge: document.getElementById('profile-anon-badge'),
};

/* =============================== Хелперы ================================== */

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
function prefersReducedMotion() {
    return reducedMotionQuery.matches;
}

/* Длительность анимации: при reduced-motion все задержки схлопываются в 0. */
function motion(ms) {
    return prefersReducedMotion() ? 0 : ms;
}

/** Иконка из спрайта: <svg class="icon"><use href="#i-name"></use></svg> */
function icon(name, extraClass) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', extraClass ? `icon ${extraClass}` : 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
}

/** Элемент с текстом. Текст всегда через textContent — никакого innerHTML. */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function normalizeAvatarColor(value) {
    return typeof value === 'string' && value.startsWith('#') ? value : AVATAR_FALLBACK;
}

function initialOf(name) {
    const str = typeof name === 'string' ? name.trim() : '';
    return str ? str.charAt(0).toUpperCase() : '?';
}

/* =============================== Запуск =================================== */

function init() {
    checkAuth();
    try {
        setupEventListeners();
    } catch (e) {
        console.error('setupEventListeners() failed — some UI controls may not respond:', e);
    }
}

async function checkAuth() {
    try {
        const res = await fetch('/api/auth');
        const data = await res.json();
        if (data.authenticated) {
            currentUser = data.user;
            showApp();
            loadChats();
        } else {
            showAuth();
        }
    } catch (e) {
        showAuth();
    }
}

/* ===================== Переход auth-экран <-> приложение =================== */

function showAuth() {
    elements.authScreen.classList.remove('hidden', 'is-leaving');
    elements.app.classList.add('hidden');
    elements.app.classList.remove('is-entering');
    resetAppState();
}

function showApp() {
    if (!elements.app.classList.contains('hidden')) return;

    elements.app.classList.remove('hidden');
    elements.app.classList.add('is-entering');
    setTimeout(() => elements.app.classList.remove('is-entering'), motion(600));

    /* Auth-экран не исчезает рывком: сначала уезжает, потом снимается с потока. */
    elements.authScreen.classList.add('is-leaving');
    setTimeout(() => {
        elements.authScreen.classList.add('hidden');
        elements.authScreen.classList.remove('is-leaving');
    }, motion(300));

    setMobileView('list');
}

function resetAppState() {
    currentChatId = null;
    currentRoomId = null;
    chatsLoadedOnce = false;
    chatLoadToken++;
    clearComposerContext();
    elements.chatsList.replaceChildren();
    elements.chatMessages.replaceChildren();
    elements.chatHeader.classList.add('hidden');
    elements.messageInputContainer.classList.add('hidden');
    elements.emptyState.classList.remove('hidden');
    elements.mainContent.classList.remove('has-chat');
    setEmptyStateMode(false);
    elements.searchInput.value = '';
    setMobileView('list');
}

/* ======================= Мобильная навигация ============================== */

/* Реальное переключение экранов: список <-> чат.
   data-mobile-view читает CSS (перевод панелей через transform),
   .hidden-mobile остаётся синонимом для сайдбара. */
function setMobileView(view) {
    elements.app.dataset.mobileView = view;
    elements.sidebar.classList.toggle('hidden-mobile', view === 'chat');
    elements.backToListBtn.setAttribute('aria-expanded', view === 'chat' ? 'true' : 'false');
}

function isMobileLayout() {
    return window.matchMedia('(max-width: 767.98px)').matches;
}

/* ================================ Тосты =================================== */

const TOAST_ICONS = { success: 'ok', error: 'alert', info: 'info' };

function showToast(message, type = 'info') {
    toastTimers.forEach(clearTimeout);
    toastTimers = [];

    elements.toast.className = `toast ${type}`;
    elements.toast.replaceChildren(
        icon(TOAST_ICONS[type] || 'info'),
        el('span', null, message === undefined || message === null ? '' : message)
    );
    elements.toast.classList.remove('hidden');

    toastTimers.push(setTimeout(() => elements.toast.classList.add('is-closing'), 2800));
    toastTimers.push(setTimeout(() => {
        elements.toast.classList.add('hidden');
        elements.toast.classList.remove('is-closing');
    }, 2800 + motion(200)));
}

/* ================================ Сеть ==================================== */

function getCsrfToken() {
    const match = document.cookie.match(/csrf_token=([^;]+)/);
    return match ? match[1] : '';
}

async function api(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken(),
        ...options.headers,
    };
    const res = await fetch(url, { ...options, headers });
    return res.json();
}

/* ============================ Обработчики ================================= */

function setupEventListeners() {
    /* ---- Вкладки авторизации ---- */
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auth-tab').forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            const target = tab.dataset.tab;
            if (elements.authTabs) elements.authTabs.dataset.active = target;
            if (target === 'login') {
                elements.loginForm.classList.add('active');
                elements.registerForm.classList.remove('active');
            } else {
                elements.loginForm.classList.remove('active');
                elements.registerForm.classList.add('active');
            }
        });
    });
    if (elements.authTabs) elements.authTabs.dataset.active = 'login';

    /* ---- Вход / регистрация / приватный режим ---- */
    elements.loginBtn.addEventListener('click', async () => {
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const data = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });
        if (data.success) {
            currentUser = data.user;
            showToast('Вход выполнен!', 'success');
            showApp();
            loadChats();
        } else {
            showToast(data.message, 'error');
        }
    });

    elements.registerBtn.addEventListener('click', async () => {
        const username = document.getElementById('register-username').value;
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const confirmPassword = document.getElementById('register-confirm-password').value;
        const data = await api('/api/register', {
            method: 'POST',
            body: JSON.stringify({ username, email, password, confirmPassword }),
        });
        if (data.success) {
            currentUser = data.user;
            showToast('Регистрация успешна!', 'success');
            showApp();
            loadChats();
        } else {
            showToast(data.message, 'error');
        }
    });

    elements.anonymousLoginBtn.addEventListener('click', async () => {
        const data = await api('/api/register/anonymous', { method: 'POST' });
        if (data.success) {
            currentUser = data.user;
            showToast('Приватный режим активирован!', 'success');
            showApp();
            loadChats();
        } else {
            showToast(data.message, 'error');
        }
    });

    elements.logoutBtn.addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        currentUser = null;
        currentChatId = null;
        currentRoomId = null;
        showToast('Вы вышли из аккаунта', 'info');
        showAuth();
    });

    /* Enter на полях авторизации — та же кнопка, что и по клику. */
    bindEnter(['login-email', 'login-password'], elements.loginBtn);
    bindEnter(['register-username', 'register-email', 'register-password', 'register-confirm-password'], elements.registerBtn);
    bindEnter(['new-chat-name'], elements.createChatBtn);
    bindEnter(['join-chat-code'], elements.joinChatBtn);
    bindEnter(['current-password', 'new-password', 'confirm-new-password'], elements.savePasswordBtn);

    /* ---- Чаты ---- */
    elements.newChatBtn.addEventListener('click', () => openModal(elements.newChatModal));
    elements.emptyNewChatBtn.addEventListener('click', () => openModal(elements.newChatModal));
    elements.createChatBtn.addEventListener('click', createChat);
    elements.joinChatBtn.addEventListener('click', joinChat);
    elements.backToListBtn.addEventListener('click', () => setMobileView('list'));

    elements.chatMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(elements.chatMenuModal);
    });

    elements.deleteChatBtn.addEventListener('click', deleteChat);

    elements.getChatCodeBtn.addEventListener('click', async () => {
        if (!currentChatId) return;
        const data = await api(`/api/chats/invite/${currentChatId}`);
        if (data.success) {
            elements.inviteCodeDisplay.textContent = data.code;
            openModal(elements.inviteModal);
        } else {
            showToast(data.message, 'error');
        }
    });

    elements.copyInviteBtn.addEventListener('click', async () => {
        const code = elements.inviteCodeDisplay.textContent;
        try {
            await navigator.clipboard.writeText(code);
            showToast('Код скопирован!', 'success');
        } catch (e) {
            showToast('Не удалось скопировать — выделите код вручную', 'error');
        }
    });

    /* ---- Профиль ---- */
    elements.profileBtn.addEventListener('click', async () => {
        const data = await api('/api/user');
        if (data.success) {
            const color = normalizeAvatarColor(data.user.avatar);
            elements.profileUsername.textContent = data.user.username;
            elements.profileEmail.textContent = data.user.email || 'Нет email (приватный режим)';
            elements.profileCode.textContent = `Код: ${data.user.uniqueCode}`;
            elements.profileAvatar.style.background = color;
            elements.profileAvatar.textContent = initialOf(data.user.username);
            markActiveColor(color);
            if (data.user.email === null || data.user.email === undefined) {
                elements.profileAnonBadge.classList.remove('hidden');
                elements.changePasswordBtn.classList.add('hidden');
            } else {
                elements.profileAnonBadge.classList.add('hidden');
                elements.changePasswordBtn.classList.remove('hidden');
            }
            openModal(elements.profileModal);
        }
    });

    elements.changePasswordBtn.addEventListener('click', () => {
        closeModal(elements.profileModal);
        openModal(elements.passwordModal);
    });

    elements.savePasswordBtn.addEventListener('click', async () => {
        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-new-password').value;
        const data = await api('/api/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
        });
        if (data.success) {
            showToast(data.message, 'success');
            closeModal(elements.passwordModal);
            setTimeout(() => {
                currentUser = null;
                showAuth();
            }, 1500);
        } else {
            showToast(data.message, 'error');
        }
    });

    document.querySelectorAll('.color-option').forEach(btn => {
        btn.addEventListener('click', async () => {
            const color = btn.dataset.color;
            const data = await api('/api/user/avatar-color', {
                method: 'POST',
                body: JSON.stringify({ avatarColor: color }),
            });
            if (data.success) {
                elements.profileAvatar.style.background = color;
                markActiveColor(color);
                if (currentUser) currentUser.avatar = color;
                showToast('Цвет обновлён', 'success');
            } else {
                showToast(data.message, 'error');
            }
        });
    });

    /* ---- Композер ---- */
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    elements.attachBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', handleFileUpload);
    elements.cancelReplyBtn.addEventListener('click', clearComposerContext);

    /* ---- Контекстное меню сообщения ---- */
    elements.replyMessageBtn.addEventListener('click', () => {
        replyToMessageId = elements.messageMenu.dataset.messageId;
        editingMessageId = null;
        setComposerContext('reply', elements.messageMenu.dataset.messageText || '');
        elements.messageInput.focus();
        hideMessageMenu();
    });

    elements.editMessageBtn.addEventListener('click', () => {
        editingMessageId = elements.messageMenu.dataset.messageId;
        replyToMessageId = null;
        const text = elements.messageMenu.dataset.messageText || '';
        elements.messageInput.value = text;
        setComposerContext('edit', text);
        elements.messageInput.focus();
        hideMessageMenu();
    });

    elements.deleteMessageBtn.addEventListener('click', async () => {
        const messageId = elements.messageMenu.dataset.messageId;
        const data = await api(`/api/messages/${messageId}`, { method: 'DELETE' });
        if (data.success) {
            showToast('Сообщение удалено', 'success');
            removeMessageElement(messageId);
        } else {
            showToast(data.message, 'error');
        }
        hideMessageMenu();
    });

    /* ---- Поиск ---- */
    let searchTimeout;
    elements.searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(performSearch, 300);
    });

    /* ---- Модалки ---- */
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', () => closeAllModals());
    });

    /* Клик мимо карточки закрывает модалку: сама .modal растянута на вьюпорт
       и перекрывает #overlay, поэтому слушаем оба. */
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal(modal);
        });
    });

    elements.overlay.addEventListener('click', () => {
        closeAllModals();
        hideMessageMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!elements.messageMenu.classList.contains('hidden')) {
            hideMessageMenu();
            return;
        }
        const openModalEl = document.querySelector('.modal:not(.hidden)');
        if (openModalEl) {
            closeModal(openModalEl);
            return;
        }
        if (isMobileLayout() && elements.app.dataset.mobileView === 'chat') {
            setMobileView('list');
        }
    });

    /* ---- Socket.io ---- */
    socket.on('newMessage', (message) => {
        if (message.chat_id == currentChatId || message.room_id == currentRoomId) {
            appendMessage(message);
            scrollToBottom();
        } else {
            loadChats();
        }
    });

    socket.on('messageEdited', ({ id, text, chat_id, room_id }) => {
        if (chat_id == currentChatId || room_id == currentRoomId) {
            const bubble = document.querySelector(`[data-message-id="${id}"]`);
            if (!bubble) return;
            const textEl = bubble.querySelector('.message-text');
            if (textEl) textEl.textContent = text;
            if (!bubble.querySelector('.edited-label')) {
                const contentEl = bubble.querySelector('.message-content');
                if (contentEl) contentEl.appendChild(el('div', 'edited-label', 'изменено'));
            }
        }
    });

    socket.on('messageDeleted', ({ id, chat_id, room_id }) => {
        if (chat_id == currentChatId || room_id == currentRoomId) {
            removeMessageElement(id);
        }
    });

    /* Клик мимо меню закрывает его. Задержка нужна для long-tap: touchend
       синтезирует click сразу после того, как меню открылось по удержанию. */
    document.addEventListener('click', () => {
        if (Date.now() - menuOpenedAt > 400) hideMessageMenu();
    });
    document.addEventListener('scroll', () => hideMessageMenu(), true);
    window.addEventListener('resize', () => hideMessageMenu());
}

function bindEnter(inputIds, button) {
    inputIds.forEach(id => {
        const input = document.getElementById(id);
        if (!input || !button) return;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                button.click();
            }
        });
    });
}

function markActiveColor(color) {
    document.querySelectorAll('.color-option').forEach(btn => {
        const isActive = (btn.dataset.color || '').toLowerCase() === String(color || '').toLowerCase();
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

/* ============================== Модалки =================================== */

function openModal(modal) {
    const pending = modalCloseTimers.get(modal);
    if (pending) {
        clearTimeout(pending);
        modalCloseTimers.delete(modal);
    }
    lastFocusedBeforeModal = document.activeElement;

    modal.classList.remove('hidden', 'is-closing');
    elements.overlay.classList.remove('hidden', 'is-closing');

    const focusTarget = modal.querySelector('input:not([type="hidden"]), button:not(.close-modal)')
        || modal.querySelector('.close-modal');
    if (focusTarget) setTimeout(() => focusTarget.focus({ preventScroll: true }), motion(60));
}

function closeModal(modal) {
    if (!modal || modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;

    modal.classList.add('is-closing');
    const isLast = document.querySelectorAll('.modal:not(.hidden):not(.is-closing)').length === 0;
    if (isLast) elements.overlay.classList.add('is-closing');

    const timer = setTimeout(() => {
        modalCloseTimers.delete(modal);
        modal.classList.add('hidden');
        modal.classList.remove('is-closing');
        if (!document.querySelector('.modal:not(.hidden)')) {
            elements.overlay.classList.add('hidden');
            elements.overlay.classList.remove('is-closing');
        }
    }, motion(200));
    modalCloseTimers.set(modal, timer);

    if (lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
        lastFocusedBeforeModal.focus({ preventScroll: true });
        lastFocusedBeforeModal = null;
    }
}

function closeAllModals() {
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => closeModal(m));
}

/* ============================ Список чатов ================================ */

function renderChatsSkeleton(count = 6) {
    elements.chatsList.replaceChildren();
    for (let i = 0; i < count; i++) {
        const row = el('div', 'chat-skeleton');
        row.appendChild(el('div', 'chat-skeleton__avatar skeleton'));
        const lines = el('div', 'chat-skeleton__lines');
        lines.appendChild(el('div', 'chat-skeleton__line chat-skeleton__line--title skeleton'));
        lines.appendChild(el('div', 'chat-skeleton__line chat-skeleton__line--sub skeleton'));
        row.appendChild(lines);
        elements.chatsList.appendChild(row);
    }
}

/* На аккаунте без чатов «выберите чат слева» отправляет в пустой список,
   поэтому текст и кнопка меняются на предложение создать первый чат. */
function setEmptyStateMode(isFirstRun) {
    elements.emptyStatePick.hidden = isFirstRun;
    elements.emptyStateFirst.hidden = !isFirstRun;
    elements.emptyNewChatBtn.hidden = !isFirstRun;
}

function renderListPlaceholder(iconName, text) {
    const box = el('div', 'list-placeholder');
    box.appendChild(icon(iconName));
    box.appendChild(el('span', null, text));
    elements.chatsList.replaceChildren(box);
}

function createChatItem(chat, options = {}) {
    const item = el('button', 'chat-item');
    item.type = 'button';
    item.dataset.id = chat.id;
    item.dataset.roomId = chat.room_id || '';
    if (options.delay) item.style.setProperty('--enter-delay', `${options.delay}ms`);

    const avatar = el('span', 'avatar avatar--sm', initialOf(chat.name));
    avatar.style.background = normalizeAvatarColor(chat.avatar);
    avatar.setAttribute('aria-hidden', 'true');
    item.appendChild(avatar);

    const body = el('span', 'chat-item__body');
    body.appendChild(el('span', 'chat-item__name', chat.name));

    const preview = chat.last_message
        ? String(chat.last_message).substring(0, 42)
        : (options.subtitle || 'Нет сообщений');
    body.appendChild(el('span', 'chat-item__last', preview));
    item.appendChild(body);

    if (chat.unread > 0) {
        const badge = el('span', 'chat-badge', chat.unread > 99 ? '99+' : chat.unread);
        badge.setAttribute('aria-label', `Непрочитанных сообщений: ${chat.unread}`);
        item.appendChild(badge);
    }

    item.addEventListener('click', () =>
        openChat(chat.id, chat.room_id, chat.name, chat.avatar, chat.online, chat.is_bot));

    return item;
}

async function loadChats() {
    if (!chatsLoadedOnce) renderChatsSkeleton();
    const data = await api('/api/chats');
    if (!data.success) {
        if (!chatsLoadedOnce) renderListPlaceholder('alert', 'Не удалось загрузить чаты');
        return;
    }
    chatsLoadedOnce = true;

    const chats = data.chats || [];
    setEmptyStateMode(chats.length === 0);
    if (chats.length === 0) {
        renderListPlaceholder('inbox', 'Чатов пока нет — создайте первый или вступите по коду.');
        return;
    }

    const fragment = document.createDocumentFragment();
    chats.forEach((chat, i) => fragment.appendChild(createChatItem(chat, { delay: Math.min(i, 8) * 26 })));
    elements.chatsList.replaceChildren(fragment);
    highlightActiveChat();
}

function highlightActiveChat() {
    elements.chatsList.querySelectorAll('.chat-item').forEach(item => {
        const isActive = currentChatId !== null && item.dataset.id === String(currentChatId);
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-current', isActive ? 'true' : 'false');
    });
}

/* ============================== Открытый чат ============================== */

function setChatStatus(online, isBot) {
    const status = elements.chatStatus;
    if (isBot) {
        status.className = 'status is-bot';
        status.replaceChildren(icon('bot'), el('span', null, 'Бот'));
        return;
    }
    status.className = `status ${online ? 'online' : 'offline'}`;
    status.replaceChildren(el('span', 'status__dot'), el('span', null, online ? 'В сети' : 'Не в сети'));
}

function renderMessagesSkeleton() {
    const fragment = document.createDocumentFragment();
    ['received', 'received', 'sent', 'received', 'sent'].forEach((side, i) => {
        const bubble = el('div', `message-skeleton skeleton ${side}`);
        bubble.style.width = `${40 + ((i * 17) % 45)}%`;
        fragment.appendChild(bubble);
    });
    elements.chatMessages.replaceChildren(fragment);
}

async function openChat(chatId, roomId, name, avatar, online, isBot) {
    const token = ++chatLoadToken;

    currentChatId = chatId;
    currentRoomId = roomId;
    clearComposerContext();

    elements.chatName.textContent = name;
    setChatStatus(online, isBot);
    elements.chatAvatar.textContent = initialOf(name);
    elements.chatAvatar.style.background = normalizeAvatarColor(avatar);
    elements.chatHeader.classList.remove('hidden');
    elements.messageInputContainer.classList.remove('hidden');
    elements.emptyState.classList.add('hidden');
    elements.mainContent.classList.add('has-chat');

    highlightActiveChat();
    setMobileView('chat');
    renderMessagesSkeleton();

    const data = await api(`/api/messages/${chatId}`);
    /* Пока грузились, пользователь мог открыть другой чат — не перетираем. */
    if (token !== chatLoadToken) return;

    elements.chatMessages.replaceChildren();
    if (!data.success) {
        elements.chatMessages.appendChild(el('div', 'list-placeholder', 'Не удалось загрузить сообщения'));
        return;
    }

    if (data.messages) {
        const fragment = document.createDocumentFragment();
        data.messages.forEach((msg, i) => {
            const node = createMessageElement(msg);
            node.style.setProperty('--enter-delay', `${Math.min(i, 10) * 22}ms`);
            fragment.appendChild(node);
        });
        elements.chatMessages.appendChild(fragment);
        scrollToBottom();
    }

    const roomKey = roomId ? `room:${roomId}` : `chat:${chatId}`;
    socket.emit('joinChat', roomKey);
}

function appendMessage(message) {
    elements.chatMessages.appendChild(createMessageElement(message));
}

function removeMessageElement(id) {
    const node = document.querySelector(`[data-message-id="${id}"]`);
    if (node) node.remove();
}

/* Вложения собираются через DOM API. .src/.href — присвоение свойства, а не
   вставка HTML-текста, вырваться из атрибута нельзя. Клик по картинке —
   addEventListener, а не инлайновый onclick (его всё равно режет CSP). */
function createFileAttachmentElement(message) {
    const { file_url, file_name, message_type } = message;

    if (message_type === 'image') {
        const img = document.createElement('img');
        img.src = file_url;
        img.className = 'message-image';
        img.loading = 'lazy';
        img.alt = file_name || 'Изображение';
        img.addEventListener('click', () => window.open(file_url, '_blank', 'noopener'));
        return img;
    }
    if (message_type === 'video') {
        const video = document.createElement('video');
        video.src = file_url;
        video.controls = true;
        video.className = 'message-video';
        return video;
    }
    if (message_type === 'audio') {
        const audio = document.createElement('audio');
        audio.src = file_url;
        audio.controls = true;
        audio.className = 'message-audio';
        return audio;
    }

    const wrapper = el('div', 'file-attachment');
    const link = document.createElement('a');
    link.href = file_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = file_name || 'file';
    link.appendChild(icon('file'));
    link.appendChild(el('span', 'file-attachment__name', file_name || 'Файл'));
    wrapper.appendChild(link);
    return wrapper;
}

const MESSAGE_STATUS = {
    read: { name: 'check-double', label: 'Прочитано', cls: 'is-read' },
    delivered: { name: 'check', label: 'Доставлено', cls: 'is-delivered' },
};

function createMessageStatus(status) {
    const meta = MESSAGE_STATUS[status] || { name: 'circle', label: 'Отправляется', cls: 'is-pending' };
    const span = el('span', `message-status ${meta.cls}`);
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', meta.label);
    span.title = meta.label;
    span.appendChild(icon(meta.name));
    return span;
}

function createMessageElement(message) {
    const isMine = message.user_id === (currentUser ? currentUser.id : 0);
    const div = el('div', `message ${isMine ? 'sent' : 'received'}`);
    div.dataset.messageId = message.id;

    const contentDiv = el('div', 'message-content');

    if (message.deleted) {
        contentDiv.appendChild(el('em', null, 'Сообщение удалено'));
    } else {
        if (message.reply_to) {
            const replyDiv = el('div', 'reply-to');
            replyDiv.appendChild(icon('reply'));
            const body = el('div', 'reply-to__body');
            body.appendChild(el('span', 'reply-to__author', message.reply_to.sender_username || 'Неизвестно'));
            body.appendChild(el('span', 'reply-to__text', (message.reply_to.text || '').substring(0, 60)));
            replyDiv.appendChild(body);
            contentDiv.appendChild(replyDiv);
        }
        if (message.file_url) {
            contentDiv.appendChild(createFileAttachmentElement(message));
        }
        contentDiv.appendChild(el('div', 'message-text', message.text || ''));

        if (message.edited_at) {
            contentDiv.appendChild(el('div', 'edited-label', 'изменено'));
        }
        if (message.reactions && message.reactions.length > 0) {
            const reactionsDiv = el('div', 'reactions');
            message.reactions.forEach(r => reactionsDiv.appendChild(el('span', 'reaction', r)));
            contentDiv.appendChild(reactionsDiv);
        }
    }

    const metaDiv = el('div', 'message-meta');
    metaDiv.appendChild(el('span', 'message-time', message.time || ''));
    if (isMine) metaDiv.appendChild(createMessageStatus(message.status));

    div.appendChild(contentDiv);
    div.appendChild(metaDiv);

    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (message.deleted) return;
        showMessageMenu(e.clientX, e.clientY, message);
    });

    div.addEventListener('touchstart', (e) => {
        if (message.deleted) return;
        const touch = e.touches[0];
        const x = touch.clientX;
        const y = touch.clientY;
        longPressTimer = setTimeout(() => showMessageMenu(x, y, message), 600);
    }, { passive: true });

    div.addEventListener('touchend', () => clearTimeout(longPressTimer));
    div.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    div.addEventListener('touchcancel', () => clearTimeout(longPressTimer));

    return div;
}

/* Позиция меню считается по реальным offsetWidth/offsetHeight, а не по
   захардкоженным 200/150 — размер меню можно менять в CSS свободно. */
function showMessageMenu(x, y, message) {
    const menu = elements.messageMenu;

    menu.dataset.messageId = message.id;
    menu.dataset.messageText = message.text || '';

    const isMine = message.user_id === (currentUser ? currentUser.id : 0);
    elements.editMessageBtn.hidden = !isMine;
    elements.deleteMessageBtn.hidden = !isMine;

    menu.classList.remove('hidden');
    menu.style.left = '0px';
    menu.style.top = '0px';

    const gap = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const flipX = x + width + gap > window.innerWidth;
    const flipY = y + height + gap > window.innerHeight;

    const left = Math.max(gap, Math.min(x, window.innerWidth - width - gap));
    const top = Math.max(gap, Math.min(y, window.innerHeight - height - gap));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.setProperty('--menu-origin', `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`);

    menuOpenedAt = Date.now();

    const firstItem = menu.querySelector('.menu-item:not([hidden])');
    if (firstItem) firstItem.focus({ preventScroll: true });
}

function hideMessageMenu() {
    elements.messageMenu.classList.add('hidden');
}

/* ========================= Контекст композера ============================= */

function setComposerContext(kind, text) {
    elements.composerContextKind.textContent = kind === 'edit' ? 'Редактирование' : 'Ответ';
    elements.replyPreviewText.textContent = String(text || '').substring(0, 100);
    elements.replyPreview.classList.remove('hidden');
    elements.messageInputContainer.classList.toggle('is-editing', kind === 'edit');
}

function clearComposerContext() {
    replyToMessageId = null;
    editingMessageId = null;
    elements.replyPreview.classList.add('hidden');
    elements.replyPreviewText.textContent = '';
    elements.messageInputContainer.classList.remove('is-editing');
}

/* ============================ Отправка ==================================== */

async function sendMessage() {
    const text = elements.messageInput.value.trim();
    if (!text) return;
    if (!currentChatId) {
        showToast('Выберите чат', 'error');
        return;
    }
    const payload = { chatId: currentChatId, text };
    if (replyToMessageId) payload.replyToId = replyToMessageId;

    if (editingMessageId) {
        const editedId = editingMessageId;
        const data = await api(`/api/messages/${editedId}`, {
            method: 'PUT',
            body: JSON.stringify({ text }),
        });
        if (data.success) {
            showToast('Сообщение изменено', 'success');
            const node = document.querySelector(`[data-message-id="${editedId}"] .message-text`);
            if (node) node.textContent = text;
        } else {
            showToast(data.message, 'error');
        }
        editingMessageId = null;
    } else {
        await api('/api/messages', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    elements.messageInput.value = '';
    clearComposerContext();
}

async function handleFileUpload() {
    const file = elements.fileInput.files[0];
    if (!file || !currentChatId) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('chatId', currentChatId);

    elements.attachBtn.disabled = true;
    try {
        const res = await fetch('/api/messages/file', {
            method: 'POST',
            headers: { 'X-CSRF-Token': getCsrfToken() },
            body: formData,
        });
        const data = await res.json();
        if (!data.success) {
            showToast(data.message, 'error');
        }
    } catch (e) {
        showToast('Не удалось отправить файл', 'error');
    } finally {
        elements.attachBtn.disabled = false;
        elements.fileInput.value = '';
    }
}

/* ============================ Управление чатами =========================== */

async function createChat() {
    const name = document.getElementById('new-chat-name').value.trim();
    if (!name) return showToast('Введите название', 'error');
    const data = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ name }),
    });
    if (data.success) {
        showToast('Чат создан', 'success');
        document.getElementById('new-chat-name').value = '';
        closeModal(elements.newChatModal);
        loadChats();
        openChat(data.chat.id, data.chat.room_id, data.chat.name, data.chat.avatar, 0, 0);
    } else {
        showToast(data.message, 'error');
    }
}

async function joinChat() {
    const code = document.getElementById('join-chat-code').value.trim();
    if (!code) return showToast('Введите код', 'error');
    const data = await api('/api/chats/join', {
        method: 'POST',
        body: JSON.stringify({ code }),
    });
    if (data.success) {
        showToast('Вы присоединились к чату', 'success');
        document.getElementById('join-chat-code').value = '';
        closeModal(elements.newChatModal);
        loadChats();
        openChat(data.chat.id, data.chat.room_id, data.chat.name, data.chat.avatar, 0, 0);
    } else {
        showToast(data.message, 'error');
    }
}

async function deleteChat() {
    if (!currentChatId) return;
    if (!confirm('Удалить чат?')) return;
    const data = await api(`/api/chats/${currentChatId}`, { method: 'DELETE' });
    if (data.success) {
        showToast('Чат удалён', 'success');
        closeModal(elements.chatMenuModal);
        currentChatId = null;
        currentRoomId = null;
        chatLoadToken++;
        elements.chatHeader.classList.add('hidden');
        elements.messageInputContainer.classList.add('hidden');
        elements.emptyState.classList.remove('hidden');
        elements.mainContent.classList.remove('has-chat');
        elements.chatMessages.replaceChildren();
        clearComposerContext();
        setMobileView('list');
        loadChats();
    } else {
        showToast(data.message, 'error');
    }
}

/* ================================ Поиск =================================== */

async function performSearch() {
    const q = elements.searchInput.value.trim();
    if (!q) return loadChats();

    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (!data.success) return;

    const chats = (data.results && data.results.chats) || [];
    if (chats.length === 0) {
        renderListPlaceholder('search', 'Ничего не найдено');
        return;
    }

    const fragment = document.createDocumentFragment();
    chats.forEach((chat, i) => {
        fragment.appendChild(createChatItem(
            { id: chat.id, room_id: null, name: chat.name, avatar: chat.avatar, online: 0, is_bot: 0 },
            { subtitle: 'Найденный чат', delay: Math.min(i, 8) * 26 }
        ));
    });
    elements.chatsList.replaceChildren(fragment);
    highlightActiveChat();
}

function scrollToBottom() {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

init();
