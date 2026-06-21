class HandwritingApp {
    constructor() {
        this.canvas = document.getElementById('previewCanvas');
        this.renderer = new HandwritingRenderer(this.canvas);
        this.exportManager = new ExportManager();
        this.exportHandlers = new ExportHandlers(this);
        this.eventHandlers = new EventHandlers(this);
        this.fontManager = new FontManager();
        
        this.syncManager = null;
        this.syncUI = null;
        
        this.currentStyle = 'kaishu';
        this.customFontFamily = null;
        this.debounceTimer = null;
        this.historySaveTimer = null;
        
        this.init();
    }

    async init() {
        this.showLoading();
        
        if (CloudSyncManager.isSupported()) {
            this.syncManager = new CloudSyncManager('http://localhost:5000/api');
            await this.syncManager.init();
            this.syncUI = new SyncUI(this, this.syncManager);
            this._bindPresetAndHistoryHandlers();
        } else {
            console.warn('当前浏览器不支持云同步所需的Web Crypto或IndexedDB API');
        }
        
        try {
            await FontLoader.loadAllFonts();
            console.log('所有字体预加载完成');
        } catch (error) {
            console.warn('预加载字体失败:', error);
        }
        
        this.eventHandlers.bindAll();
        await this.eventHandlers.applyStyle('kaishu');
        this.generatePreview();
        
        this.hideLoading();
        
        this._scheduleAutoHistorySave();
    }

    _bindPresetAndHistoryHandlers() {
        const savePresetBtn = document.getElementById('savePresetBtn');
        const loadPresetBtn = document.getElementById('loadPresetBtn');
        const saveHistoryBtn = document.getElementById('saveHistoryBtn');
        const viewHistoryBtn = document.getElementById('viewHistoryBtn');
        
        if (savePresetBtn) {
            savePresetBtn.addEventListener('click', () => this._handleSavePreset());
        }
        if (loadPresetBtn) {
            loadPresetBtn.addEventListener('click', () => this._handleLoadPreset());
        }
        if (saveHistoryBtn) {
            saveHistoryBtn.addEventListener('click', () => this._handleSaveHistory());
        }
        if (viewHistoryBtn) {
            viewHistoryBtn.addEventListener('click', () => this._handleViewHistory());
        }
    }

    _requireSyncLogin() {
        if (!this.syncManager || !this.syncManager.authToken) {
            if (this.syncUI) {
                this.syncUI._showLoginModal();
            } else {
                alert('请先登录云同步账户');
            }
            return false;
        }
        return true;
    }

    async _handleSavePreset() {
        if (!this._requireSyncLogin()) return;
        
        const name = prompt('请输入预设名称:', `预设-${new Date().toLocaleDateString()}`);
        if (!name) return;
        
        try {
            const preset = await this.syncUI.saveCurrentPreset(name);
            if (preset) {
                this.syncUI._showToast(`预设 "${name}" 已保存`, 'success');
            }
        } catch (e) {
            this.syncUI._showToast('保存预设失败: ' + e.message, 'error');
        }
    }

    async _handleLoadPreset() {
        if (!this._requireSyncLogin()) return;
        
        const container = document.getElementById('presetListContainer');
        const historyContainer = document.getElementById('historyListContainer');
        historyContainer.style.display = 'none';
        
        if (container.style.display === 'block') {
            container.style.display = 'none';
            return;
        }
        
        try {
            const presets = await this.syncManager.getPresets();
            if (presets.length === 0) {
                container.innerHTML = '<p class="muted" style="font-size:12px;color:#888;">暂无保存的预设</p>';
            } else {
                container.innerHTML = presets.map(p => `
                    <div class="preset-item" data-id="${p.id}">
                        <div class="preset-info">
                            <strong>${p.name || '未命名预设'}</strong>
                            <span class="muted small">${p.style || '-'}</span>
                        </div>
                        <div class="preset-actions-row">
                            <button class="btn-small" data-action="apply">应用</button>
                            <button class="btn-small btn-danger" data-action="delete">删除</button>
                        </div>
                    </div>
                `).join('');
                
                container.querySelectorAll('.preset-item').forEach(item => {
                    const id = item.dataset.id;
                    item.querySelector('[data-action="apply"]').addEventListener('click', () => this._applyPreset(id, presets));
                    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
                        if (confirm('确定删除此预设吗？')) {
                            await this.syncManager.deletePreset(id);
                            this._handleLoadPreset();
                        }
                    });
                });
            }
            container.style.display = 'block';
        } catch (e) {
            this.syncUI._showToast('加载预设失败: ' + e.message, 'error');
        }
    }

    async _applyPreset(id, presets) {
        const preset = presets.find(p => p.id === id);
        if (!preset) return;
        
        if (preset.style) {
            this.currentStyle = preset.style;
            await this.eventHandlers.applyStyle(preset.style);
        }
        
        if (preset.options) {
            this.renderer.setOptions(preset.options);
            this.eventHandlers.updateUIFromOptions(preset.options);
        }
        
        this.generatePreview();
        document.getElementById('presetListContainer').style.display = 'none';
        this.syncUI._showToast(`已应用预设: ${preset.name}`, 'success');
    }

    async _handleSaveHistory() {
        if (!this._requireSyncLogin()) return;
        
        try {
            await this.syncUI.saveCurrentStateAsHistory();
            this.syncUI._showToast('历史记录已保存', 'success');
        } catch (e) {
            this.syncUI._showToast('保存历史失败: ' + e.message, 'error');
        }
    }

    async _handleViewHistory() {
        if (!this._requireSyncLogin()) return;
        
        const container = document.getElementById('historyListContainer');
        const presetContainer = document.getElementById('presetListContainer');
        presetContainer.style.display = 'none';
        
        if (container.style.display === 'block') {
            container.style.display = 'none';
            return;
        }
        
        try {
            const history = await this.syncManager.getHistory();
            if (history.length === 0) {
                container.innerHTML = '<p class="muted" style="font-size:12px;color:#888;">暂无历史记录</p>';
            } else {
                const sorted = [...history].sort((a, b) => 
                    new Date(b.createdAt || b.updatedAt) - new Date(a.createdAt || a.updatedAt)
                );
                
                container.innerHTML = sorted.slice(0, 20).map(h => `
                    <div class="history-item" data-id="${h.id}">
                        <div class="history-info">
                            <strong>${h.preview || '历史记录'}</strong>
                            <span class="muted small">${new Date(h.createdAt || h.updatedAt).toLocaleString()}</span>
                        </div>
                        <div class="history-actions-row">
                            <button class="btn-small" data-action="apply">恢复</button>
                            <button class="btn-small btn-danger" data-action="delete">删除</button>
                        </div>
                    </div>
                `).join('');
                
                container.querySelectorAll('.history-item').forEach(item => {
                    const id = item.dataset.id;
                    item.querySelector('[data-action="apply"]').addEventListener('click', () => this._applyHistory(id, sorted));
                    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
                        if (confirm('确定删除此历史记录吗？')) {
                            await this.syncManager.deleteHistory(id);
                            this._handleViewHistory();
                        }
                    });
                });
            }
            container.style.display = 'block';
        } catch (e) {
            this.syncUI._showToast('加载历史记录失败: ' + e.message, 'error');
        }
    }

    async _applyHistory(id, history) {
        const item = history.find(h => h.id === id);
        if (!item) return;
        
        if (item.text !== undefined) {
            document.getElementById('textInput').value = item.text;
        }
        
        if (item.style) {
            this.currentStyle = item.style;
            await this.eventHandlers.applyStyle(item.style);
        }
        
        if (item.options) {
            this.renderer.setOptions(item.options);
            this.eventHandlers.updateUIFromOptions(item.options);
        }
        
        this.generatePreview();
        document.getElementById('historyListContainer').style.display = 'none';
        this.syncUI._showToast('历史记录已恢复', 'success');
    }

    _scheduleAutoHistorySave() {
        document.getElementById('textInput').addEventListener('input', () => {
            if (this.syncManager && this.syncManager.authToken) {
                if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
                this.historySaveTimer = setTimeout(() => {
                    this.syncUI.saveCurrentStateAsHistory().catch(e => {});
                }, 60000);
            }
        });
    }

    debouncedGenerate() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.generatePreview();
        }, 150);
    }

    generatePreview() {
        const text = document.getElementById('textInput').value;
        this.renderer.setOptions({ text });
        
        this.showLoading();
        
        requestAnimationFrame(() => {
            const startTime = performance.now();
            
            const pageCount = this.renderer.renderPage(this.renderer.currentPage);
            
            const endTime = performance.now();
            console.log(`生成耗时: ${(endTime - startTime).toFixed(2)}ms, 共 ${pageCount} 页`);
            
            this.updatePageInfo();
            this.hideLoading();
        });
    }

    changePage(direction) {
        const pageCount = this.renderer.getPageCount();
        let newPage = this.renderer.currentPage + direction;
        
        if (newPage < 0) newPage = 0;
        if (newPage >= pageCount) newPage = pageCount - 1;
        
        if (newPage !== this.renderer.currentPage) {
            this.renderer.renderPage(newPage);
            this.updatePageInfo();
        }
    }

    updatePageInfo() {
        const current = this.renderer.currentPage + 1;
        const total = this.renderer.getPageCount();
        document.getElementById('pageInfo').textContent = `第 ${current} 页 / 共 ${total} 页`;
        
        document.getElementById('prevPage').disabled = this.renderer.currentPage === 0;
        document.getElementById('nextPage').disabled = this.renderer.currentPage >= total - 1;
    }

    async exportCurrentPage() {
        await this.exportHandlers.exportCurrentPageDirect();
    }

    async exportAllPages() {
        await this.exportHandlers.exportAllPages();
    }

    async exportLongImage() {
        await this.exportHandlers.exportLongImage();
    }

    showLoading() {
        document.getElementById('loading').style.display = 'block';
    }

    hideLoading() {
        document.getElementById('loading').style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const initApp = async () => {
        if (document.fonts && document.fonts.ready) {
            try {
                await document.fonts.ready;
            } catch (e) {
                console.warn('字体加载等待超时');
            }
        }
        window.app = new HandwritingApp();
    };
    
    initApp();
});
