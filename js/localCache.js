class LocalCache {
    constructor(dbName = 'HandwritingSyncDB', dbVersion = 1) {
        this.dbName = dbName;
        this.dbVersion = dbVersion;
        this.db = null;
        this.initPromise = null;
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        
        this.initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(new Error('无法打开IndexedDB'));
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                if (!db.objectStoreNames.contains('fonts')) {
                    const fontStore = db.createObjectStore('fonts', { keyPath: 'id' });
                    fontStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    fontStore.createIndex('version', 'version', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('presets')) {
                    const presetStore = db.createObjectStore('presets', { keyPath: 'id' });
                    presetStore.createIndex('name', 'name', { unique: false });
                    presetStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    presetStore.createIndex('version', 'version', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('history')) {
                    const historyStore = db.createObjectStore('history', { keyPath: 'id' });
                    historyStore.createIndex('createdAt', 'createdAt', { unique: false });
                    historyStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    historyStore.createIndex('version', 'version', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('syncMeta')) {
                    db.createObjectStore('syncMeta', { keyPath: 'key' });
                }
                
                if (!db.objectStoreNames.contains('pendingChanges')) {
                    const pendingStore = db.createObjectStore('pendingChanges', { keyPath: 'id', autoIncrement: true });
                    pendingStore.createIndex('itemId', 'itemId', { unique: false });
                    pendingStore.createIndex('itemType', 'itemType', { unique: false });
                    pendingStore.createIndex('createdAt', 'createdAt', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('conflicts')) {
                    db.createObjectStore('conflicts', { keyPath: 'itemId' });
                }
                
                if (!db.objectStoreNames.contains('auth')) {
                    db.createObjectStore('auth', { keyPath: 'key' });
                }
            };
        });
        
        return this.initPromise;
    }

    async _getStore(storeName, mode = 'readonly') {
        await this.init();
        const transaction = this.db.transaction(storeName, mode);
        return transaction.objectStore(storeName);
    }

    async _requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async putItem(storeName, item) {
        const store = await this._getStore(storeName, 'readwrite');
        const existing = await this.getItem(storeName, item.id);
        
        if (existing && !item.version) {
            item.version = (existing.version || 1);
        } else if (!item.version) {
            item.version = 1;
        }
        
        if (!item.updatedAt) {
            item.updatedAt = new Date().toISOString();
        }
        
        await this._requestToPromise(store.put(item));
        return item;
    }

    async getItem(storeName, id) {
        const store = await this._getStore(storeName);
        return this._requestToPromise(store.get(id));
    }

    async deleteItem(storeName, id) {
        const store = await this._getStore(storeName, 'readwrite');
        const item = await this.getItem(storeName, id);
        if (item) {
            item.isDeleted = true;
            item.updatedAt = new Date().toISOString();
            item.version = (item.version || 1) + 1;
            await this._requestToPromise(store.put(item));
        }
        return item;
    }

    async hardDeleteItem(storeName, id) {
        const store = await this._getStore(storeName, 'readwrite');
        await this._requestToPromise(store.delete(id));
    }

    async getAllItems(storeName, includeDeleted = false) {
        const store = await this._getStore(storeName);
        const all = await this._requestToPromise(store.getAll());
        if (includeDeleted) return all;
        return all.filter(item => !item.isDeleted);
    }

    async getItemsByIndex(storeName, indexName, value) {
        const store = await this._getStore(storeName);
        const index = store.index(indexName);
        return this._requestToPromise(index.getAll(value));
    }

    async clearStore(storeName) {
        const store = await this._getStore(storeName, 'readwrite');
        await this._requestToPromise(store.clear());
    }

    async setMeta(key, value) {
        const store = await this._getStore('syncMeta', 'readwrite');
        await this._requestToPromise(store.put({ key, value, updatedAt: new Date().toISOString() }));
    }

    async getMeta(key, defaultValue = null) {
        const store = await this._getStore('syncMeta');
        const result = await this._requestToPromise(store.get(key));
        return result ? result.value : defaultValue;
    }

    async deleteMeta(key) {
        const store = await this._getStore('syncMeta', 'readwrite');
        await this._requestToPromise(store.delete(key));
    }

    async addPendingChange(change) {
        const store = await this._getStore('pendingChanges', 'readwrite');
        change.createdAt = change.createdAt || new Date().toISOString();
        const id = await this._requestToPromise(store.add(change));
        return { ...change, id };
    }

    async getPendingChanges(itemType = null) {
        const store = await this._getStore('pendingChanges');
        let changes = await this._requestToPromise(store.getAll());
        if (itemType) {
            changes = changes.filter(c => c.itemType === itemType);
        }
        return changes.sort((a, b) => (a.id || 0) - (b.id || 0));
    }

    async clearPendingChanges(ids = null) {
        const store = await this._getStore('pendingChanges', 'readwrite');
        if (ids) {
            for (const id of ids) {
                await this._requestToPromise(store.delete(id));
            }
        } else {
            await this._requestToPromise(store.clear());
        }
    }

    async saveConflict(conflict) {
        const store = await this._getStore('conflicts', 'readwrite');
        conflict.resolved = false;
        conflict.createdAt = conflict.createdAt || new Date().toISOString();
        await this._requestToPromise(store.put(conflict));
        return conflict;
    }

    async getConflicts() {
        const store = await this._getStore('conflicts');
        const all = await this._requestToPromise(store.getAll());
        return all.filter(c => !c.resolved);
    }

    async resolveConflict(itemId, resolution) {
        const store = await this._getStore('conflicts', 'readwrite');
        const conflict = await this._requestToPromise(store.get(itemId));
        if (conflict) {
            conflict.resolved = true;
            conflict.resolution = resolution;
            conflict.resolvedAt = new Date().toISOString();
            await this._requestToPromise(store.put(conflict));
        }
        return conflict;
    }

    async clearResolvedConflicts() {
        const store = await this._getStore('conflicts', 'readwrite');
        const all = await this._requestToPromise(store.getAll());
        for (const conflict of all) {
            if (conflict.resolved) {
                await this._requestToPromise(store.delete(conflict.itemId));
            }
        }
    }

    async setAuth(authData) {
        const store = await this._getStore('auth', 'readwrite');
        for (const [key, value] of Object.entries(authData)) {
            await this._requestToPromise(store.put({ key, value, updatedAt: new Date().toISOString() }));
        }
    }

    async getAuth(key) {
        const store = await this._getStore('auth');
        const result = await this._requestToPromise(store.get(key));
        return result ? result.value : null;
    }

    async clearAuth() {
        const store = await this._getStore('auth', 'readwrite');
        await this._requestToPromise(store.clear());
    }

    async getStats() {
        const stats = {};
        for (const storeName of ['fonts', 'presets', 'history']) {
            const items = await this.getAllItems(storeName);
            stats[storeName] = items.length;
        }
        stats.pendingChanges = (await this.getPendingChanges()).length;
        stats.conflicts = (await this.getConflicts()).length;
        return stats;
    }

    async exportAll() {
        const data = {};
        for (const storeName of ['fonts', 'presets', 'history', 'syncMeta', 'pendingChanges', 'conflicts']) {
            const store = await this._getStore(storeName);
            data[storeName] = await this._requestToPromise(store.getAll());
        }
        return data;
    }

    async importAll(data) {
        for (const [storeName, items] of Object.entries(data)) {
            if (Array.isArray(items)) {
                const store = await this._getStore(storeName, 'readwrite');
                await this._requestToPromise(store.clear());
                for (const item of items) {
                    await this._requestToPromise(store.put(item));
                }
            }
        }
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initPromise = null;
        }
    }

    static isSupported() {
        return typeof indexedDB !== 'undefined';
    }
}

if (typeof window !== 'undefined') {
    window.LocalCache = LocalCache;
}
