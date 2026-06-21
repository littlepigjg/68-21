class SyncUI {
    constructor(app, syncManager) {
        this.app = app;
        this.sync = syncManager;
        this.modal = null;
        this.init();
    }

    init() {
        this._injectModalHTML();
        this._injectSyncUI();
        this._bindEvents();
        this._refreshStatusUI();
    }

    _injectSyncUI() {
        const header = document.querySelector('header');
        if (!header) return;
        
        const syncContainer = document.createElement('div');
        syncContainer.className = 'sync-controls';
        syncContainer.innerHTML = `
            <div class="sync-status" id="syncStatusBadge" title="同步状态">
                <span class="sync-icon" id="syncStatusIcon">☁️</span>
                <span class="sync-label" id="syncStatusLabel">未登录</span>
            </div>
            <div class="sync-buttons">
                <button id="syncBtn" class="btn-sync" title="立即同步">🔄 同步</button>
                <button id="accountBtn" class="btn-account" title="账户管理">👤 账户</button>
            </div>
        `;
        header.appendChild(syncContainer);
    }

    _injectModalHTML() {
        const modalHTML = `
            <div class="sync-modal" id="syncModal" style="display:none">
                <div class="sync-modal-overlay" data-action="close"></div>
                <div class="sync-modal-content">
                    <div class="sync-modal-header">
                        <h3 id="syncModalTitle">云同步</h3>
                        <button class="sync-modal-close" data-action="close">&times;</button>
                    </div>
                    <div class="sync-modal-body" id="syncModalBody">
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.modal = document.getElementById('syncModal');
    }

    _bindEvents() {
        document.getElementById('accountBtn').addEventListener('click', () => this._showAccountModal());
        document.getElementById('syncBtn').addEventListener('click', () => this._handleSyncClick());
        
        this.modal.addEventListener('click', (e) => {
            if (e.target.dataset.action === 'close') {
                this._closeModal();
            }
        });

        this.sync.on('syncStatus', (status) => this._handleSyncStatus(status));
        this.sync.on('auth', (auth) => this._handleAuthChange(auth));
        this.sync.on('conflict', (conflict) => this._handleConflict(conflict));
        this.sync.on('pendingChange', (data) => this._refreshStatusUI());
        this.sync.on('network', (data) => this._refreshStatusUI());
    }

    async _handleSyncClick() {
        if (!this.sync.authToken) {
            this._showLoginModal();
            return;
        }
        try {
            await this.sync.sync();
            this._showToast('同步完成', 'success');
        } catch (e) {
            if (e.message === '离线模式' || e.offline) {
                this._showToast('当前离线，将在恢复网络后自动同步', 'warning');
            } else {
                this._showToast('同步失败: ' + e.message, 'error');
            }
        }
    }

    _handleSyncStatus(status) {
        const icon = document.getElementById('syncStatusIcon');
        const label = document.getElementById('syncStatusLabel');
        
        switch (status.status) {
            case 'syncing':
                icon.textContent = '⏳';
                icon.classList.add('syncing');
                label.textContent = '同步中...';
                break;
            case 'synced':
                icon.textContent = '✅';
                icon.classList.remove('syncing');
                label.textContent = '已同步';
                setTimeout(() => this._refreshStatusUI(), 2000);
                break;
            case 'error':
                icon.textContent = '⚠️';
                icon.classList.remove('syncing');
                label.textContent = '同步错误';
                break;
            case 'offline':
                icon.textContent = '📴';
                icon.classList.remove('syncing');
                label.textContent = '离线';
                break;
            default:
                this._refreshStatusUI();
        }
    }

    async _refreshStatusUI() {
        const icon = document.getElementById('syncStatusIcon');
        const label = document.getElementById('syncStatusLabel');
        const syncBtn = document.getElementById('syncBtn');
        
        if (!this.sync.isOnline) {
            icon.textContent = '📴';
            label.textContent = '离线模式';
            syncBtn.disabled = true;
        } else if (!this.sync.authToken) {
            icon.textContent = '☁️';
            label.textContent = '未登录';
            syncBtn.disabled = false;
        } else {
            const pending = await this.sync.cache.getPendingChanges();
            const conflicts = await this.sync.cache.getConflicts();
            
            if (conflicts.length > 0) {
                icon.textContent = '⚔️';
                label.textContent = `${conflicts.length}个冲突`;
            } else if (pending.length > 0) {
                icon.textContent = '📤';
                label.textContent = `${pending.length}项待同步`;
            } else {
                icon.textContent = '✅';
                label.textContent = `已登录 (${this.sync.username})`;
            }
            syncBtn.disabled = false;
        }
    }

    _handleAuthChange(auth) {
        this._refreshStatusUI();
        if (auth.authenticated) {
            this._closeModal();
            this._showToast(`欢迎, ${auth.username}!`, 'success');
            this.sync.scheduleAutoSync(30000);
            setTimeout(() => this.sync.sync(), 500);
        }
    }

    async _handleConflict(conflict) {
        this._refreshStatusUI();
        const count = (await this.sync.cache.getConflicts()).length;
        this._showToast(`检测到${count}个数据冲突，请在账户管理中处理`, 'warning');
    }

    _showModal(content, title = '云同步') {
        document.getElementById('syncModalTitle').textContent = title;
        document.getElementById('syncModalBody').innerHTML = content;
        this.modal.style.display = 'flex';
    }

    _closeModal() {
        this.modal.style.display = 'none';
    }

    _showAccountModal() {
        if (this.sync.authToken) {
            this._showLoggedInView();
        } else {
            this._showLoginModal();
        }
    }

    async _showLoggedInView() {
        const stats = await this.sync.getStats();
        const conflicts = await this.sync.cache.getConflicts();
        const pending = await this.sync.cache.getPendingChanges();
        
        let conflictHTML = '';
        if (conflicts.length > 0) {
            conflictHTML = `
                <div class="sync-section">
                    <h4>⚠️ 待解决的冲突 (${conflicts.length})</h4>
                    <div class="conflict-list">
                        ${conflicts.map(c => this._renderConflictItem(c)).join('')}
                    </div>
                </div>
            `;
        }
        
        const content = `
            <div class="sync-account-view">
                <div class="sync-section">
                    <div class="account-info">
                        <div class="account-avatar">👤</div>
                        <div class="account-details">
                            <h4>${this.sync.username}</h4>
                            <p class="muted">ID: ${this.sync.userId ? this.sync.userId.slice(0, 16) + '...' : '-'}</p>
                        </div>
                    </div>
                </div>
                
                <div class="sync-section">
                    <h4>📊 同步状态</h4>
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-label">网络</div>
                            <div class="stat-value ${stats.isOnline ? 'success' : 'warning'}">
                                ${stats.isOnline ? '🌐 在线' : '📴 离线'}
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">本地字体</div>
                            <div class="stat-value">${stats.local.fonts || 0}</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">本地预设</div>
                            <div class="stat-value">${stats.local.presets || 0}</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">历史记录</div>
                            <div class="stat-value">${stats.local.history || 0}</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">待同步</div>
                            <div class="stat-value ${pending.length > 0 ? 'warning' : ''}">${pending.length}</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-label">冲突</div>
                            <div class="stat-value ${conflicts.length > 0 ? 'error' : ''}">${conflicts.length}</div>
                        </div>
                    </div>
                    ${stats.lastSyncAt ? `<p class="muted small">上次同步: ${new Date(stats.lastSyncAt).toLocaleString()}</p>` : ''}
                </div>
                
                ${conflictHTML}
                
                <div class="sync-section">
                    <h4>⚙️ 操作</h4>
                    <div class="action-buttons">
                        <button class="btn-primary" id="manualSyncBtn">🔄 立即同步</button>
                        <button class="btn-secondary" id="exportDataBtn">💾 导出本地数据</button>
                        <button class="btn-secondary" id="importDataBtn">📂 导入数据</button>
                        <button class="btn-danger" id="logoutBtn">🚪 登出</button>
                    </div>
                </div>
            </div>
        `;
        
        this._showModal(content, '账户管理');
        this._bindLoggedInActions();
    }

    _renderConflictItem(conflict) {
        const typeNames = { fonts: '字体', presets: '参数预设', history: '历史记录' };
        const localName = this._extractName(conflict.localData);
        const serverName = this._extractName(conflict.serverData);
        
        return `
            <div class="conflict-item" data-item-id="${conflict.itemId}">
                <div class="conflict-header">
                    <span class="conflict-type">${typeNames[conflict.itemType] || conflict.itemType}</span>
                    <span class="conflict-strategy">策略: ${conflict.resolutionStrategy}</span>
                </div>
                <div class="conflict-versions">
                    <div class="version-box">
                        <h5>📱 本地版本</h5>
                        ${conflict.localData && !conflict.localData.isDeleted ? `
                            <p><strong>${localName || '未命名'}</strong></p>
                            <p class="muted small">${conflict.localData.updatedAt ? new Date(conflict.localData.updatedAt).toLocaleString() : '-'}</p>
                        ` : '<p class="muted">已删除</p>'}
                    </div>
                    <div class="version-arrow">⚔️</div>
                    <div class="version-box">
                        <h5>☁️ 服务器版本</h5>
                        ${!conflict.serverIsDeleted ? `
                            <p><strong>${serverName || '未命名'}</strong></p>
                            <p class="muted small">${new Date(conflict.serverUpdatedAt).toLocaleString()}</p>
                        ` : '<p class="muted">已删除</p>'}
                    </div>
                </div>
                <div class="conflict-actions">
                    <button class="btn-secondary btn-small" data-action="resolve-client">使用本地</button>
                    <button class="btn-secondary btn-small" data-action="resolve-merge">尝试合并</button>
                    <button class="btn-primary btn-small" data-action="resolve-server">使用服务器</button>
                </div>
            </div>
        `;
    }

    _extractName(data) {
        if (!data) return null;
        return data.name || data.fontName || data.presetName || data.title || null;
    }

    _bindLoggedInActions() {
        document.getElementById('manualSyncBtn').addEventListener('click', async () => {
            try {
                const result = await this.sync.sync();
                if (result.conflicts > 0) {
                    this._showLoggedInView();
                } else {
                    this._showToast('同步成功!', 'success');
                    this._closeModal();
                }
            } catch (e) {
                this._showToast('同步失败: ' + e.message, 'error');
            }
        });
        
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            if (confirm('确定要登出吗？未同步的本地数据将会保留。')) {
                await this.sync.logout();
                this._showToast('已登出', 'info');
                this._closeModal();
            }
        });
        
        document.getElementById('exportDataBtn').addEventListener('click', async () => {
            try {
                const data = await this.sync.cache.exportAll();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `handwriting-sync-backup-${new Date().toISOString().slice(0,10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                this._showToast('数据导出成功', 'success');
            } catch (e) {
                this._showToast('导出失败: ' + e.message, 'error');
            }
        });
        
        document.getElementById('importDataBtn').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (confirm('导入将覆盖现有本地数据，确定继续吗？')) {
                        await this.sync.cache.importAll(data);
                        this._showToast('数据导入成功', 'success');
                        this._showLoggedInView();
                    }
                } catch (err) {
                    this._showToast('导入失败: ' + err.message, 'error');
                }
            };
            input.click();
        });
        
        document.querySelectorAll('[data-action^="resolve-"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const itemId = e.target.closest('.conflict-item').dataset.itemId;
                const action = e.target.dataset.action;
                const resolution = action === 'resolve-server' ? 'SERVER' 
                    : action === 'resolve-client' ? 'CLIENT' 
                    : 'MERGE';
                
                try {
                    await this.sync.resolveConflict(itemId, resolution);
                    this._showToast('冲突已解决', 'success');
                    this._showLoggedInView();
                } catch (err) {
                    this._showToast('解决冲突失败: ' + err.message, 'error');
                }
            });
        });
    }

    _showLoginModal() {
        const content = `
            <div class="sync-auth-view">
                <div class="auth-tabs">
                    <button class="auth-tab active" data-tab="login">登录</button>
                    <button class="auth-tab" data-tab="register">注册</button>
                </div>
                
                <div class="auth-form" id="loginForm">
                    <div class="form-group">
                        <label>用户名</label>
                        <input type="text" id="loginUsername" placeholder="请输入用户名" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label>密码</label>
                        <input type="password" id="loginPassword" placeholder="请输入密码" autocomplete="current-password">
                    </div>
                    <p class="auth-hint">💡 数据使用端到端加密，服务器无法读取您的内容</p>
                    <button class="btn-primary btn-block" id="loginSubmitBtn">登 录</button>
                </div>
                
                <div class="auth-form" id="registerForm" style="display:none">
                    <div class="form-group">
                        <label>用户名</label>
                        <input type="text" id="regUsername" placeholder="至少3个字符" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label>密码</label>
                        <input type="password" id="regPassword" placeholder="至少6个字符" autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <label>确认密码</label>
                        <input type="password" id="regPasswordConfirm" placeholder="再次输入密码" autocomplete="new-password">
                    </div>
                    <p class="auth-hint">
                        🔐 使用 PBKDF2-HMAC-SHA256 + AES-256-GCM 端到端加密<br>
                        ⚠️ 请牢记密码，无法找回！
                    </p>
                    <button class="btn-primary btn-block" id="registerSubmitBtn">注 册</button>
                </div>
            </div>
        `;
        
        this._showModal(content, '账户登录');
        this._bindAuthActions();
    }

    _bindAuthActions() {
        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                
                const tabName = e.target.dataset.tab;
                document.getElementById('loginForm').style.display = tabName === 'login' ? 'block' : 'none';
                document.getElementById('registerForm').style.display = tabName === 'register' ? 'block' : 'none';
            });
        });
        
        document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value;
            
            if (!username || !password) {
                this._showToast('请填写用户名和密码', 'error');
                return;
            }
            
            try {
                document.getElementById('loginSubmitBtn').disabled = true;
                document.getElementById('loginSubmitBtn').textContent = '登录中...';
                await this.sync.login(username, password);
            } catch (e) {
                this._showToast(e.message, 'error');
            } finally {
                document.getElementById('loginSubmitBtn').disabled = false;
                document.getElementById('loginSubmitBtn').textContent = '登 录';
            }
        });
        
        document.getElementById('registerSubmitBtn').addEventListener('click', async () => {
            const username = document.getElementById('regUsername').value.trim();
            const password = document.getElementById('regPassword').value;
            const confirm = document.getElementById('regPasswordConfirm').value;
            
            if (!username || username.length < 3) {
                this._showToast('用户名至少3个字符', 'error');
                return;
            }
            if (!password || password.length < 6) {
                this._showToast('密码至少6个字符', 'error');
                return;
            }
            if (password !== confirm) {
                this._showToast('两次密码不一致', 'error');
                return;
            }
            
            try {
                document.getElementById('registerSubmitBtn').disabled = true;
                document.getElementById('registerSubmitBtn').textContent = '注册中...';
                await this.sync.register(username, password);
            } catch (e) {
                this._showToast(e.message, 'error');
            } finally {
                document.getElementById('registerSubmitBtn').disabled = false;
                document.getElementById('registerSubmitBtn').textContent = '注 册';
            }
        });
        
        ['loginUsername', 'loginPassword'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') document.getElementById('loginSubmitBtn').click();
            });
        });
        ['regUsername', 'regPassword', 'regPasswordConfirm'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') document.getElementById('registerSubmitBtn').click();
            });
        });
    }

    _showToast(message, type = 'info') {
        const existing = document.querySelector('.sync-toast');
        if (existing) existing.remove();
        
        const toast = document.createElement('div');
        toast.className = `sync-toast toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    async saveCurrentStateAsHistory() {
        if (!this.sync.authToken) return;
        
        const text = document.getElementById('textInput')?.value || '';
        if (!text.trim()) return;
        
        const historyItem = {
            text: text.substring(0, 5000),
            options: { ...this.app.renderer.options },
            style: this.app.currentStyle,
            createdAt: new Date().toISOString(),
            preview: text.substring(0, 50)
        };
        
        await this.sync.saveHistory(historyItem);
    }

    async saveCurrentPreset(name) {
        if (!this.sync.authToken) {
            this._showLoginModal();
            return null;
        }
        
        const preset = {
            name: name || `预设 ${new Date().toLocaleDateString()}`,
            style: this.app.currentStyle,
            options: { ...this.app.renderer.options },
            createdAt: new Date().toISOString()
        };
        
        return await this.sync.savePreset(preset);
    }
}

if (typeof window !== 'undefined') {
    window.SyncUI = SyncUI;
}
