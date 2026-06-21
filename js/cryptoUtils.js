class CryptoUtils {
    constructor() {
        this.algorithm = 'AES-GCM';
        this.keyDerivation = 'PBKDF2';
        this.hashAlgorithm = 'SHA-256';
        this.tagLength = 128;
        this.ivLength = 12;
    }

    async deriveEncryptionKey(password, salt, iterations = 100000, keyLength = 256) {
        if (!password || !salt) {
            throw new Error('密码和盐值不能为空');
        }

        const encoder = new TextEncoder();
        const passwordBuffer = encoder.encode(typeof password === 'string' ? password : JSON.stringify(password));
        const saltBuffer = encoder.encode(typeof salt === 'string' ? salt : JSON.stringify(salt));

        const importedKey = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            { name: this.keyDerivation },
            false,
            ['deriveKey', 'deriveBits']
        );

        const derivedKey = await crypto.subtle.deriveKey(
            {
                name: this.keyDerivation,
                salt: saltBuffer,
                iterations: iterations,
                hash: this.hashAlgorithm
            },
            importedKey,
            { name: this.algorithm, length: keyLength },
            false,
            ['encrypt', 'decrypt']
        );

        const rawBits = await crypto.subtle.deriveBits(
            {
                name: this.keyDerivation,
                salt: saltBuffer,
                iterations: iterations,
                hash: this.hashAlgorithm
            },
            importedKey,
            256
        );

        const keyHash = await this.bufferToHex(rawBits);

        return {
            key: derivedKey,
            keyHash: keyHash,
            params: {
                algorithm: this.keyDerivation + '-HMAC-' + this.hashAlgorithm.replace('-', ''),
                iterations: iterations,
                keyLength: keyLength,
                salt: typeof salt === 'string' ? salt : this.bufferToHex(saltBuffer)
            }
        };
    }

    async encrypt(data, key) {
        const encoder = new TextEncoder();
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
        const dataBuffer = encoder.encode(dataStr);

        const iv = crypto.getRandomValues(new Uint8Array(this.ivLength));

        const encryptedBuffer = await crypto.subtle.encrypt(
            {
                name: this.algorithm,
                iv: iv,
                tagLength: this.tagLength
            },
            key,
            dataBuffer
        );

        const ciphertextLength = encryptedBuffer.byteLength - (this.tagLength / 8);
        const ciphertext = new Uint8Array(encryptedBuffer, 0, ciphertextLength);
        const tag = new Uint8Array(encryptedBuffer, ciphertextLength, this.tagLength / 8);

        return {
            encryptedData: this.bufferToBase64(ciphertext),
            iv: this.bufferToBase64(iv),
            tag: this.bufferToBase64(tag),
            dataHash: await this.computeHash(encryptedBuffer)
        };
    }

    async decrypt(encryptedDataB64, ivB64, tagB64, key) {
        const ciphertext = this.base64ToBuffer(encryptedDataB64);
        const iv = this.base64ToBuffer(ivB64);
        const tag = this.base64ToBuffer(tagB64);

        const combined = new Uint8Array(ciphertext.length + tag.length);
        combined.set(ciphertext, 0);
        combined.set(tag, ciphertext.length);

        const decryptedBuffer = await crypto.subtle.decrypt(
            {
                name: this.algorithm,
                iv: iv,
                tagLength: this.tagLength
            },
            key,
            combined
        );

        const decoder = new TextDecoder();
        const decryptedStr = decoder.decode(decryptedBuffer);

        try {
            return JSON.parse(decryptedStr);
        } catch {
            return decryptedStr;
        }
    }

    async computeHash(data) {
        let buffer;
        if (typeof data === 'string') {
            buffer = new TextEncoder().encode(data);
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            buffer = data;
        } else {
            buffer = new TextEncoder().encode(JSON.stringify(data));
        }

        const hashBuffer = await crypto.subtle.digest(this.hashAlgorithm, buffer);
        return this.bufferToHex(hashBuffer);
    }

    async computeDataHash(encryptedDataB64, ivB64, tagB64) {
        const combinedStr = encryptedDataB64 + ivB64 + tagB64;
        return this.computeHash(combinedStr);
    }

    generateDeviceId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return this.bufferToHex(array);
    }

    generateItemId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    bufferToBase64(buffer) {
        if (buffer instanceof Uint8Array || buffer instanceof ArrayBuffer) {
            const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        }
        throw new Error('不支持的buffer类型');
    }

    base64ToBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    bufferToHex(buffer) {
        if (buffer instanceof Uint8Array || buffer instanceof ArrayBuffer) {
            const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            return Array.from(bytes)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }
        throw new Error('不支持的buffer类型');
    }

    hexToBuffer(hex) {
        if (hex.length % 2 !== 0) {
            throw new Error('十六进制字符串长度必须为偶数');
        }
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    }

    isCryptoSupported() {
        return typeof crypto !== 'undefined'
            && typeof crypto.subtle !== 'undefined'
            && typeof TextEncoder !== 'undefined'
            && typeof TextDecoder !== 'undefined';
    }
}

if (typeof window !== 'undefined') {
    window.CryptoUtils = CryptoUtils;
}
