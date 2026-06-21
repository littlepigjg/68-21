class CloudSyncManager {
    constructor(apiBaseUrl = 'http://localhost:5000/api') {
        this.apiBaseUrl = apiBaseUrl;
        this.crypto = new CryptoUtils();
        this.cache = new LocalCache();
        this.encryptionKey = null;
        this.keyHash = null;
        this.authToken = null;
        this.userId = null;
        this.username = null;
        this.deviceId = null;
        this.isOnline = navigator.onLine;
        this.isSyncing = false;
        this.autoSyncInterval = null;
        this.eventListeners = {};
        
        this._initNetworkListeners();
    }

    _initNetworkListeners() {
        window.addEventListener('online', () => {
            this.isOnline = true;
            this._emit('network', { online: true });
            this.scheduleAutoSync();
        });
        
        window.addEventListener('offline', () => {
            this.isOnline = false;
            this._emit('network', { online: false });
        });
    }

    on(event, callback) {
        if (!this.eventListeners[event]) {
            this.eventListeners[event] = [];
        }
        this.eventListeners[event].push(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        if (this.eventListeners[event]) {
            this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
        }
    }

    _emit(event, data) {
        if (this.eventListeners[event]) {
            for (const callback of this.eventListeners[event]) {
                try { callback(data); } catch (e) { console.error(e); }
            }
        }
    }

    async init() {
        await this.cache.init();
        
        this.deviceId = await this.cache.getMeta('deviceId');
        if (!this.deviceId) {
            this.deviceId = this.crypto.generateDeviceId();
            await this.cache.setMeta('deviceId', this.deviceId);
        }
        
        this.authToken = await this.cache.getAuth('token');
        this.userId = await this.cache.getAuth('userId');
        this.username = await this.cache.getAuth('username');
        const keyHash = await this.cache.getAuth('keyHash');
        
        if (this.authToken) {
            try {
                const status = await this.getSyncStatus();
                if (status && status.success) {
                    this._emit('auth', { authenticated: true, username: this.username });
                }
            } catch (e) {
                console.warn('验证认证状态失败:', e);
            }
        }
        
        return {
            isAuthenticated: !!this.authToken,
            hasKey: !!keyHash,
            deviceId: this.deviceId,
            isOnline: this.isOnline
        };
    }

    async _fetchKdfParams(username) {
        const response = await fetch(`${this.apiBaseUrl}/auth/kdf-params?username=${encodeURIComponent(username)}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '获取KDF参数失败');
        return data.kdfParams;
    }

    async register(username, password) {
        if (!this.crypto.isCryptoSupported()) {
            throw new Error('当前浏览器不支持Web Crypto API');
        }
        
        const kdfParams = await this._fetchKdfParams(username);
        const keyResult = await this.crypto.deriveEncryptionKey(
            password,
            kdfParams.salt,
            kdfParams.iterations,
            kdfParams.keyLength
        );
        
        const response = await fetch(`${this.apiBaseUrl}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password,
                deviceId: this.deviceId
            })
        });
        
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '注册失败');
        
        this.authToken = data.token;
        this.userId = data.userId;
        this.username = data.username;
        this.deviceId = data.deviceId;
        this.encryptionKey = keyResult.key;
        this.keyHash = keyResult.keyHash;
        
        await this.cache.setAuth({
            token: this.authToken,
            userId: this.userId,
            username: this.username,
            deviceId: this.deviceId,
            keyHash: this.keyHash
        });
        
        await this.cache.setMeta('deviceId', this.deviceId);
        await this.cache.setMeta('serverVersion', 0);
        
        this._emit('auth', { authenticated: true, username: this.username, isNew: true });
        
        return data;
    }

    async login(username, password) {
        if (!this.crypto.isCryptoSupported()) {
            throw new Error('当前浏览器不支持Web Crypto API');
        }
        
        const kdfParams = await this._fetchKdfParams(username);
        const keyResult = await this.crypto.deriveEncryptionKey(
            password,
            kdfParams.salt,
            kdfParams.iterations,
            kdfParams.keyLength
        );
        
        const response = await fetch(`${this.apiBaseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password,
                deviceId: this.deviceId
            })
        });
        
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '登录失败');
        
        this.authToken = data.token;
        this.userId = data.userId;
        this.username = data.username;
        this.deviceId = data.deviceId;
        this.encryptionKey = keyResult.key;
        this.keyHash = keyResult.keyHash;
        
        await this.cache.setAuth({
            token: this.authToken,
            userId: this.userId,
            username: this.username,
            deviceId: this.deviceId,
            keyHash: this.keyHash
        });
        
        await this.cache.setMeta('deviceId', this.deviceId);
        
        this._emit('auth', { authenticated: true, username: this.username });
        
        return data;
    }

    async logout() {
        if (this.authToken) {
            try {
                await fetch(`${this.apiBaseUrl}/auth/logout`, {
                    method: 'POST',
                    headers: this._authHeaders()
                });
            } catch (e) {}
        }
        
        this.authToken = null;
        this.userId = null;
        this.username = null;
        this.encryptionKey = null;
        this.keyHash = null;
        
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
        
        await this.cache.clearAuth();
        this._emit('auth', { authenticated: false });
    }

    async unlockWithPassword(password) {
        if (!this.username) {
            throw new Error('请先登录');
        }
        
        const kdfParams = await this._fetchKdfParams(this.username);
        const keyResult = await this.crypto.deriveEncryptionKey(
            password,
            kdfParams.salt,
            kdfParams.iterations,
            kdfParams.keyLength
        );
        
        const storedKeyHash = await this.cache.getAuth('keyHash');
        if (storedKeyHash && keyResult.keyHash !== storedKeyHash) {
            throw new Error('密码错误');
        }
        
        this.encryptionKey = keyResult.key;
        this.keyHash = keyResult.keyHash;
        
        return true;
    }

    _authHeaders(extra = {}) {
        return {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
            ...extra
        };
    }

    async _ensureKey() {
        if (!this.encryptionKey) {
            throw new Error('加密密钥未就绪，请重新登录');
        }
    }

    async saveFont(fontData) {
        const id = fontData.id || this.crypto.generateItemId();
        const now = new Date().toISOString();
        const existing = await this.cache.getItem('fonts', id);
        const version = existing ? (existing.version || 1) + 1 : 1;
        
        const item = {
            id,
            itemType: 'fonts',
            ...fontData,
            id,
            version,
            updatedAt: now,
            updatedBy: this.deviceId,
            isDeleted: !!fontData.isDeleted
        };
        
        await this.cache.putItem('fonts', item);
        await this._queueChange({
            itemId: id,
            itemType: 'fonts',
            operation: fontData.isDeleted ? 'DELETE' : (existing ? 'UPDATE' : 'CREATE'),
            baseVersion: existing ? (existing.version || 1) : 0,
            localVersion: version,
            data: item
        });
        
        this._emit('change', { type: 'fonts', item });
        return item;
    }

    async savePreset(presetData) {
        const id = presetData.id || this.crypto.generateItemId();
        const now = new Date().toISOString();
        const existing = await this.cache.getItem('presets', id);
        const version = existing ? (existing.version || 1) + 1 : 1;
        
        const item = {
            id,
            itemType: 'presets',
            ...presetData,
            id,
            version,
            updatedAt: now,
            updatedBy: this.deviceId,
            isDeleted: !!presetData.isDeleted
        };
        
        await this.cache.putItem('presets', item);
        await this._queueChange({
            itemId: id,
            itemType: 'presets',
            operation: presetData.isDeleted ? 'DELETE' : (existing ? 'UPDATE' : 'CREATE'),
            baseVersion: existing ? (existing.version || 1) : 0,
            localVersion: version,
            data: item
        });
        
        this._emit('change', { type: 'presets', item });
        return item;
    }

    async saveHistory(historyData) {
        const id = historyData.id || this.crypto.generateItemId();
        const now = new Date().toISOString();
        const existing = await this.cache.getItem('history', id);
        const version = existing ? (existing.version || 1) + 1 : 1;
        
        const item = {
            id,
            itemType: 'history',
            ...historyData,
            id,
            version,
            updatedAt: now,
            updatedBy: this.deviceId,
            isDeleted: !!historyData.isDeleted
        };
        
        await this.cache.putItem('history', item);
        await this._queueChange({
            itemId: id,
            itemType: 'history',
            operation: historyData.isDeleted ? 'DELETE' : (existing ? 'UPDATE' : 'CREATE'),
            baseVersion: existing ? (existing.version || 1) : 0,
            localVersion: version,
            data: item
        });
        
        this._emit('change', { type: 'history', item });
        return item;
    }

    async deleteFont(id) {
        const item = await this.saveFont({ id, isDeleted: true });
        return item;
    }

    async deletePreset(id) {
        const item = await this.savePreset({ id, isDeleted: true });
        return item;
    }

    async deleteHistory(id) {
        const item = await this.saveHistory({ id, isDeleted: true });
        return item;
    }

    async getFonts() { return this.cache.getAllItems('fonts'); }
    async getPresets() { return this.cache.getAllItems('presets'); }
    async getHistory() { return this.cache.getAllItems('history'); }

    async _queueChange(change) {
        const existingPending = await this.cache.getPendingChanges();
        const merged = existingPending.find(c => 
            c.itemId === change.itemId && c.itemType === change.itemType
        );
        
        if (merged) {
            change.id = merged.id;
            change.operation = change.operation === 'DELETE' ? 'DELETE' 
                : (merged.operation === 'CREATE' ? 'CREATE' : 'UPDATE');
            change.baseVersion = merged.baseVersion;
        }
        
        if (change.id) {
            await this.cache.clearPendingChanges([change.id]);
        }
        
        await this.cache.addPendingChange(change);
        this._emit('pendingChange', { pendingCount: (await this.cache.getPendingChanges()).length });
    }

    async _encryptItem(item) {
        await this._ensureKey();
        const dataToEncrypt = { ...item };
        delete dataToEncrypt.encryptedData;
        delete dataToEncrypt.iv;
        delete dataToEncrypt.tag;
        delete dataToEncrypt.dataHash;
        
        const encrypted = await this.crypto.encrypt(dataToEncrypt, this.encryptionKey);
        const dataHash = await this.crypto.computeDataHash(
            encrypted.encryptedData,
            encrypted.iv,
            encrypted.tag
        );
        
        return {
            encryptedData: encrypted.encryptedData,
            iv: encrypted.iv,
            tag: encrypted.tag,
            dataHash: dataHash
        };
    }

    async _decryptChange(change) {
        if (!change.encryptedData || !change.iv || !change.tag) return null;
        await this._ensureKey();
        try {
            return await this.crypto.decrypt(
                change.encryptedData,
                change.iv,
                change.tag,
                this.encryptionKey
            );
        } catch (e) {
            console.warn('解密失败:', e);
            return null;
        }
    }

    async getSyncStatus() {
        const response = await fetch(`${this.apiBaseUrl}/sync/status`, {
            headers: this._authHeaders()
        });
        return response.json();
    }

    async sync() {
        if (this.isSyncing) {
            return { success: false, skipped: true, reason: '已在同步中' };
        }
        if (!this.authToken) {
            return { success: false, error: '未登录' };
        }
        if (!this.isOnline) {
            this._emit('syncStatus', { status: 'offline' });
            return { success: false, error: '离线模式', offline: true };
        }
        
        this.isSyncing = true;
        this._emit('syncStatus', { status: 'syncing' });
        
        try {
            const pullResult = await this._pullChanges();
            const pushResult = await this._pushChanges();
            
            const conflicts = await this.cache.getConflicts();
            
            await this.cache.setMeta('lastSyncAt', new Date().toISOString());
            
            const result = {
                success: true,
                pull: pullResult,
                push: pushResult,
                conflicts: conflicts.length
            };
            
            this._emit('sync', result);
            this._emit('syncStatus', { status: 'synced', result });
            
            return result;
            
        } catch (e) {
            this._emit('syncStatus', { status: 'error', error: e.message });
            throw e;
        } finally {
            this.isSyncing = false;
        }
    }

    async _pullChanges() {
        const lastSyncVersion = await this.cache.getMeta('serverVersion', 0);
        
        const response = await fetch(`${this.apiBaseUrl}/sync/pull`, {
            method: 'POST',
            headers: this._authHeaders(),
            body: JSON.stringify({
                lastSyncVersion: lastSyncVersion
            })
        });
        
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '拉取变更失败');
        
        let applied = 0;
        let decryptErrors = 0;
        
        for (const change of data.changes) {
            const storeMap = {
                'fonts': 'fonts',
                'presets': 'presets',
                'history': 'history'
            };
            const storeName = storeMap[change.itemType];
            if (!storeName) continue;
            
            if (change.operation === 'DELETE' || change.isDeleted) {
                const existing = await this.cache.getItem(storeName, change.itemId);
                if (existing) {
                    existing.isDeleted = true;
                    existing.version = change.version;
                    existing.updatedAt = change.changedAt;
                    existing.updatedBy = change.changedBy;
                    await this.cache.putItem(storeName, existing);
                    applied++;
                }
                continue;
            }
            
            const decrypted = await this._decryptChange(change);
            if (!decrypted) {
                decryptErrors++;
                continue;
            }
            
            decrypted.version = change.version;
            decrypted.updatedAt = change.changedAt;
            decrypted.updatedBy = change.changedBy;
            decrypted.isDeleted = false;
            
            const existing = await this.cache.getItem(storeName, change.itemId);
            if (!existing || change.version >= (existing.version || 0)) {
                await this.cache.putItem(storeName, decrypted);
                applied++;
            }
        }
        
        if (data.serverVersion > lastSyncVersion) {
            await this.cache.setMeta('serverVersion', data.serverVersion);
        }
        
        return {
            serverVersion: data.serverVersion,
            changeCount: data.changeCount,
            applied,
            decryptErrors
        };
    }

    async _pushChanges() {
        const pendingChanges = await this.cache.getPendingChanges();
        if (pendingChanges.length === 0) {
            return { pushed: 0, conflicts: [] };
        }
        
        const payloadChanges = [];
        const toRemove = [];
        
        for (const change of pendingChanges) {
            if (change.operation === 'DELETE') {
                payloadChanges.push({
                    itemId: change.itemId,
                    itemType: change.itemType,
                    operation: 'DELETE',
                    baseVersion: change.baseVersion
                });
                toRemove.push(change.id);
            } else if (change.data) {
                try {
                    const encrypted = await this._encryptItem(change.data);
                    payloadChanges.push({
                        itemId: change.itemId,
                        itemType: change.itemType,
                        operation: change.operation === 'CREATE' ? 'CREATE' : 'UPDATE',
                        baseVersion: change.baseVersion,
                        encryptedData: encrypted.encryptedData,
                        iv: encrypted.iv,
                        tag: encrypted.tag,
                        dataHash: encrypted.dataHash
                    });
                    toRemove.push(change.id);
                } catch (e) {
                    console.warn('加密变更失败:', e);
                }
            }
        }
        
        if (payloadChanges.length === 0) {
            return { pushed: 0, conflicts: [] };
        }
        
        const clientVersion = await this.cache.getMeta('serverVersion', 0);
        
        const response = await fetch(`${this.apiBaseUrl}/sync/push`, {
            method: 'POST',
            headers: this._authHeaders(),
            body: JSON.stringify({
                changes: payloadChanges,
                clientVersion: clientVersion
            })
        });
        
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '推送变更失败');
        
        if (toRemove.length > 0 && data.conflictCount === 0) {
            await this.cache.clearPendingChanges(toRemove);
        } else if (data.appliedChanges && data.appliedChanges.length > 0) {
            const appliedIds = new Set(data.appliedChanges.map(c => c.itemId));
            const idsToRemove = pendingChanges
                .filter(c => appliedIds.has(c.itemId))
                .map(c => c.id);
            if (idsToRemove.length > 0) {
                await this.cache.clearPendingChanges(idsToRemove);
            }
        }
        
        for (const conflict of data.conflicts) {
            await this._handleServerConflict(conflict);
        }
        
        if (data.serverVersion > clientVersion) {
            await this.cache.setMeta('serverVersion', data.serverVersion);
        }
        
        this._emit('pendingChange', { pendingCount: (await this.cache.getPendingChanges()).length });
        
        return {
            pushed: data.appliedCount || 0,
            appliedChanges: data.appliedChanges || [],
            conflicts: data.conflicts || [],
            conflictCount: data.conflictCount || 0,
            serverVersion: data.serverVersion
        };
    }

    async _handleServerConflict(conflict) {
        const serverData = await this._decryptChange({
            encryptedData: conflict.serverEncryptedData,
            iv: conflict.serverIv,
            tag: conflict.serverTag
        });
        
        const storeMap = {
            'fonts': 'fonts',
            'presets': 'presets',
            'history': 'history'
        };
        const storeName = storeMap[conflict.itemType];
        
        let localData = null;
        if (storeName) {
            localData = await this.cache.getItem(storeName, conflict.itemId);
        }
        
        const conflictRecord = {
            itemId: conflict.itemId,
            itemType: conflict.itemType,
            serverVersion: conflict.serverVersion,
            clientBaseVersion: conflict.clientBaseVersion,
            serverData,
            localData,
            serverUpdatedAt: conflict.serverUpdatedAt,
            serverUpdatedBy: conflict.serverUpdatedBy,
            serverIsDeleted: conflict.serverIsDeleted,
            resolutionStrategy: conflict.resolutionStrategy || 'LWW',
            resolved: false,
            createdAt: new Date().toISOString()
        };
        
        await this.cache.saveConflict(conflictRecord);
        this._emit('conflict', conflictRecord);
        
        await this._tryAutoResolve(conflictRecord, storeName);
    }

    async _tryAutoResolve(conflict, storeName) {
        const strategy = conflict.resolutionStrategy;
        
        if (conflict.serverIsDeleted && conflict.localData) {
            if (strategy === 'LWW') {
                if (new Date(conflict.serverUpdatedAt) >= new Date(conflict.localData.updatedAt || 0)) {
                    await this.resolveConflict(conflict.itemId, 'SERVER');
                    return 'auto_server_deleted';
                } else {
                    await this.resolveConflict(conflict.itemId, 'CLIENT');
                    return 'auto_client_undeleted';
                }
            }
        }
        
        if (!conflict.localData) {
            await this.resolveConflict(conflict.itemId, 'SERVER');
            return 'auto_server_no_local';
        }
        
        if (!conflict.serverData && !conflict.serverIsDeleted) {
            await this.resolveConflict(conflict.itemId, 'CLIENT');
            return 'auto_client_no_server';
        }
        
        if (strategy === 'LWW' && conflict.serverData && conflict.localData) {
            const serverTime = new Date(conflict.serverUpdatedAt).getTime();
            const localTime = new Date(conflict.localData.updatedAt || 0).getTime();
            if (serverTime >= localTime) {
                await this.resolveConflict(conflict.itemId, 'SERVER');
                return 'auto_lww_server';
            } else {
                await this.resolveConflict(conflict.itemId, 'CLIENT');
                return 'auto_lww_client';
            }
        }
        
        return 'manual_required';
    }

    async resolveConflict(itemId, resolution) {
        const conflicts = await this.cache.getConflicts();
        const conflict = conflicts.find(c => c.itemId === itemId);
        if (!conflict) throw new Error('冲突不存在');
        
        const storeMap = {
            'fonts': 'fonts',
            'presets': 'presets',
            'history': 'history'
        };
        const storeName = storeMap[conflict.itemType];
        
        if (resolution === 'SERVER') {
            if (conflict.serverIsDeleted) {
                if (storeName) {
                    await this.cache.deleteItem(storeName, itemId);
                }
            } else if (conflict.serverData && storeName) {
                conflict.serverData.version = conflict.serverVersion;
                await this.cache.putItem(storeName, conflict.serverData);
            }
            
            await fetch(`${this.apiBaseUrl}/sync/resolve-conflict`, {
                method: 'POST',
                headers: this._authHeaders(),
                body: JSON.stringify({
                    itemId,
                    resolution: 'SERVER'
                })
            });
            
        } else if (resolution === 'CLIENT') {
            if (conflict.localData) {
                const localVersion = conflict.localData.version || 1;
                conflict.localData.version = conflict.serverVersion + 1;
                conflict.localData.updatedAt = new Date().toISOString();
                conflict.localData.updatedBy = this.deviceId;
                
                if (storeName) {
                    await this.cache.putItem(storeName, conflict.localData);
                }
                
                if (!conflict.localData.isDeleted) {
                    const encrypted = await this._encryptItem(conflict.localData);
                    await fetch(`${this.apiBaseUrl}/sync/resolve-conflict`, {
                        method: 'POST',
                        headers: this._authHeaders(),
                        body: JSON.stringify({
                            itemId,
                            resolution: 'CLIENT',
                            encryptedData: encrypted.encryptedData,
                            iv: encrypted.iv,
                            tag: encrypted.tag
                        })
                    });
                }
            }
        } else if (resolution === 'MERGE') {
            const merged = this._mergeData(conflict.localData, conflict.serverData);
            merged.version = conflict.serverVersion + 1;
            merged.updatedAt = new Date().toISOString();
            merged.updatedBy = this.deviceId;
            
            if (storeName) {
                await this.cache.putItem(storeName, merged);
            }
            
            const encrypted = await this._encryptItem(merged);
            await fetch(`${this.apiBaseUrl}/sync/resolve-conflict`, {
                method: 'POST',
                headers: this._authHeaders(),
                body: JSON.stringify({
                    itemId,
                    resolution: 'CLIENT',
                    encryptedData: encrypted.encryptedData,
                    iv: encrypted.iv,
                    tag: encrypted.tag
                })
            });
        }
        
        await this.cache.resolveConflict(itemId, resolution);
        await this.cache.clearResolvedConflicts();
        
        this._emit('conflictResolved', { itemId, resolution });
        
        return true;
    }

    _mergeData(local, server) {
        if (!local) return { ...server };
        if (!server) return { ...local };
        
        const merged = { ...server };
        for (const [key, value] of Object.entries(local)) {
            if (key === 'id' || key === 'version' || key === 'updatedAt' || key === 'updatedBy') continue;
            if (value !== undefined && value !== null) {
                merged[key] = value;
            }
        }
        return merged;
    }

    scheduleAutoSync(intervalMs = 30000) {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
        }
        
        this.autoSyncInterval = setInterval(async () => {
            if (this.authToken && this.isOnline && !this.isSyncing) {
                const pending = await this.cache.getPendingChanges();
                if (pending.length > 0) {
                    try {
                        await this.sync();
                    } catch (e) {
                        console.warn('自动同步失败:', e);
                    }
                }
            }
        }, intervalMs);
        
        return this.autoSyncInterval;
    }

    stopAutoSync() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    async getStats() {
        const cacheStats = await this.cache.getStats();
        let serverStats = null;
        
        if (this.authToken && this.isOnline) {
            try {
                const status = await this.getSyncStatus();
                if (status.success) {
                    serverStats = {
                        serverVersion: status.serverVersion,
                        isInSync: status.isInSync,
                        pendingChanges: status.pendingChanges,
                        itemCounts: status.itemCounts
                    };
                }
            } catch (e) {}
        }
        
        return {
            local: cacheStats,
            server: serverStats,
            isOnline: this.isOnline,
            isAuthenticated: !!this.authToken,
            username: this.username,
            lastSyncAt: await this.cache.getMeta('lastSyncAt')
        };
    }

    static isSupported() {
        return CryptoUtils.prototype.isCryptoSupported() && LocalCache.isSupported();
    }
}

if (typeof window !== 'undefined') {
    window.CloudSyncManager = CloudSyncManager;
}
