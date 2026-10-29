/** 会议记录管理页面 */

const minimizeBtn = document.getElementById("minimizeBtn");
const maximizeBtn = document.getElementById("maximizeBtn");
const closeBtn = document.getElementById("closeBtn");
const searchInput = document.getElementById("searchInput");
const listContainer = document.getElementById("listContainer");
const totalCount = document.getElementById("totalCount");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const pageCurrent = document.getElementById("pageCurrent");
const jumpInput = document.getElementById("jumpInput");
const sortIcon = document.getElementById("sortIcon");
const sortHeader = document.getElementById("sortHeader");

const PAGE_SIZE = 10;
let sessions = [];
let total = 0;
let currentPage = 1;
let currentSort = "newest";
let requestVersion = 0;
let searchTimer = null;
let renameState = null;

const LANG_MAP = { zh: "中文", en: "英文", ja: "日文", ko: "韩文", fr: "法文", de: "德文", es: "西班牙文", ru: "俄文", it: "意大利文", pt: "葡萄牙文", ar: "阿拉伯文" };

function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "-";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}小时${minutes}分钟`;
    if (minutes > 0) return `${minutes}分钟`;
    return `${Math.floor(seconds % 60)}秒`;
}

function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(String(value).replace(/-/g, "/"));
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月${String(date.getDate()).padStart(2, "0")}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getTotalPages() {
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function renderStatus(iconClass, message, isLoading = false) {
    const status = createElement("div", "empty-state list-status");
    const icon = createElement("i", iconClass);
    if (isLoading) icon.classList.add("is-loading");
    status.append(icon, document.createTextNode(message));
    listContainer.replaceChildren(status);
}

function createActionButton(className, iconClass, title, id) {
    const button = createElement("button", `action-btn ${className}`);
    button.type = "button";
    button.title = title;
    button.dataset.id = String(id);
    button.setAttribute("aria-label", title);
    button.appendChild(createElement("i", iconClass));
    return button;
}

function createSessionRow(session, index) {
    const item = createElement("div", "list-item");
    item.dataset.id = String(session.id);
    const name = session.name || "未命名会议";
    const langText = session.source_lang && session.target_lang
        ? `${LANG_MAP[session.source_lang] || session.source_lang} → ${LANG_MAP[session.target_lang] || session.target_lang}`
        : "-";
    const nameElement = createElement("div", "item-name", name);
    nameElement.title = name;
    const actions = createElement("div", "item-action");
    const actionButtons = createElement("div", "action-btns");
    actionButtons.append(
        createActionButton("view-btn", "ri-eye-line", "查看详情", session.id),
        createActionButton("rename", "ri-edit-line", "重命名", session.id),
        createActionButton("delete", "ri-delete-bin-line", "删除", session.id),
    );
    actions.appendChild(actionButtons);
    item.append(
        createElement("div", "item-index", String(index)),
        nameElement,
        createElement("div", "item-time", formatDateTime(session.ended_at || session.started_at)),
        createElement("div", "item-duration", formatDuration(session.duration_seconds)),
        createElement("div", "item-langs", langText),
        actions,
    );
    return item;
}

function renderList() {
    renameState = null;
    if (sessions.length === 0) {
        renderStatus("ri-folder-open-line", "暂无会议记录");
        return;
    }
    const offset = (currentPage - 1) * PAGE_SIZE;
    const fragment = document.createDocumentFragment();
    sessions.forEach((session, index) => fragment.appendChild(createSessionRow(session, offset + index + 1)));
    listContainer.replaceChildren(fragment);
}

function renderPagination() {
    const totalPages = getTotalPages();
    pageCurrent.textContent = String(currentPage);
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages || total === 0;
    jumpInput.max = String(totalPages);
    jumpInput.disabled = total === 0;
    totalCount.textContent = `共 ${total} 条会议记录`;
}

async function loadSessions() {
    const version = ++requestVersion;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((currentPage - 1) * PAGE_SIZE), sort: currentSort });
    const search = searchInput.value.trim();
    if (search) params.set("search", search);
    renderStatus("ri-loader-4-line", "正在加载会议记录...", true);
    totalCount.textContent = "正在加载...";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    try {
        const response = await fetch(`/api/sessions?${params.toString()}`);
        if (!response.ok) throw new Error(`请求失败 (${response.status})`);
        const data = await response.json();
        if (version !== requestVersion) return;
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
        total = Number.isFinite(Number(data.total)) ? Number(data.total) : sessions.length;
        if (currentPage > getTotalPages()) {
            currentPage = getTotalPages();
            loadSessions();
            return;
        }
        renderList();
        renderPagination();
    } catch (error) {
        if (version !== requestVersion) return;
        sessions = [];
        total = 0;
        console.error("加载会议列表失败:", error);
        renderStatus("ri-error-warning-line", "加载失败，请检查后端服务");
        renderPagination();
    }
}

function goPage(page) {
    const nextPage = Math.max(1, Math.min(getTotalPages(), page));
    if (nextPage === currentPage || total === 0) return;
    currentPage = nextPage;
    loadSessions();
}

async function deleteSession(id) {
    if (!confirm("确定要删除这条会议记录吗？")) return;
    try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`删除失败 (${response.status})`);
        await loadSessions();
    } catch (error) {
        console.error("删除会议失败:", error);
        alert("删除失败，请稍后重试");
    }
}

function findSession(id) {
    return sessions.find((session) => String(session.id) === String(id));
}

function findSessionRow(id) {
    return Array.from(listContainer.children).find((item) => item.dataset.id === String(id));
}

function cancelRename() {
    if (!renameState) return;
    renameState = null;
    renderList();
}

async function saveRename() {
    if (!renameState || renameState.saving) return;
    const { id, input, originalName } = renameState;
    const name = input.value.trim();
    if (!name) {
        input.classList.add("rename-input-error");
        input.title = "会议名称不能为空";
        input.focus();
        return;
    }
    if (name === originalName) {
        cancelRename();
        return;
    }

    renameState.saving = true;
    input.disabled = true;
    input.classList.remove("rename-input-error");
    try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        if (!response.ok) throw new Error(`重命名失败 (${response.status})`);
        const data = await response.json().catch(() => ({}));
        const session = findSession(id);
        if (session) session.name = data.session?.name || data.name || name;
        renameState = null;
        renderList();
    } catch (error) {
        console.error("重命名会议失败:", error);
        if (!renameState || renameState.id !== id) return;
        renameState.saving = false;
        input.disabled = false;
        input.classList.add("rename-input-error");
        input.title = "保存失败，请重试";
        input.focus();
    }
}

function startRename(id) {
    if (renameState) cancelRename();
    const session = findSession(id);
    const row = findSessionRow(id);
    if (!session || !row) return;
    const nameElement = row.querySelector(".item-name");
    const originalName = session.name || "未命名会议";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rename-input";
    input.value = originalName;
    input.setAttribute("aria-label", "会议名称");
    nameElement.classList.add("is-editing");
    nameElement.replaceChildren(input);
    renameState = { id: String(id), input, originalName, saving: false };
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            saveRename();
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancelRename();
        }
    });
    input.addEventListener("input", () => {
        input.classList.remove("rename-input-error");
        input.title = "";
    });
    input.addEventListener("blur", () => {
        window.setTimeout(() => {
            if (renameState?.input === input && !renameState.saving) cancelRename();
        }, 0);
    });
    input.focus();
    input.select();
}

function viewSession(id) {
    if (window.electronAPI?.openDetailWindow) {
        window.electronAPI.openDetailWindow(id);
        if (window.electronAPI.closeWindow) setTimeout(() => window.electronAPI.closeWindow(), 100);
        return;
    }
    window.open(`./detail.html?id=${encodeURIComponent(id)}`, "_blank");
}

function bindEvents() {
    if (window.electronAPI) {
        minimizeBtn.addEventListener("click", () => window.electronAPI.minimizeWindow());
        maximizeBtn.addEventListener("click", () => window.electronAPI.maximizeWindow());
        closeBtn.addEventListener("click", () => window.electronAPI.closeWindow());
    }
    searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            currentPage = 1;
            loadSessions();
        }, 250);
    });
    sortHeader.addEventListener("click", () => {
        currentSort = currentSort === "newest" ? "oldest" : "newest";
        sortIcon.className = currentSort === "newest" ? "ri-arrow-down-s-fill sort-icon" : "ri-arrow-up-s-fill sort-icon";
        currentPage = 1;
        loadSessions();
    });
    prevBtn.addEventListener("click", () => goPage(currentPage - 1));
    nextBtn.addEventListener("click", () => goPage(currentPage + 1));
    jumpInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") goPage(Number.parseInt(jumpInput.value, 10) || 1);
    });
    listContainer.addEventListener("click", (event) => {
        const button = event.target.closest(".action-btn");
        if (!button || !button.dataset.id) return;
        if (button.classList.contains("view-btn")) viewSession(button.dataset.id);
        else if (button.classList.contains("rename")) startRename(button.dataset.id);
        else if (button.classList.contains("delete")) deleteSession(button.dataset.id);
    });
}

bindEvents();
loadSessions();
