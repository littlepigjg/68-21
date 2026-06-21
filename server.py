from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from PIL import Image, ImageDraw, ImageFont
from werkzeug.utils import secure_filename
import os
import io
import uuid
import json
import time
import threading
import hmac
import hashlib
import sqlite3
import secrets
import base64
from datetime import datetime, timedelta
from functools import wraps

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

UPLOAD_FOLDER = 'uploads'
OUTPUT_FOLDER = 'output'
FONTS_FOLDER = 'uploads/fonts'
TASKS_FOLDER = 'tasks'

for folder in [UPLOAD_FOLDER, OUTPUT_FOLDER, FONTS_FOLDER, TASKS_FOLDER]:
    os.makedirs(folder, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

fonts_db = {}
tasks_db = {}

tasks_lock = threading.Lock()

SYNC_DB_PATH = 'sync_data.db'
SYNC_ENCRYPTED_FOLDER = 'sync_encrypted'
SERVER_SECRET = secrets.token_hex(32)
TOKEN_EXPIRY_HOURS = 24 * 7

for folder in [SYNC_ENCRYPTED_FOLDER]:
    os.makedirs(folder, exist_ok=True)

sync_db_lock = threading.Lock()


def init_sync_db():
    conn = sqlite3.connect(SYNC_DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT NOT NULL,
            kdf_params TEXT NOT NULL
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sync_items (
            item_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            encrypted_data BLOB NOT NULL,
            iv TEXT NOT NULL,
            tag TEXT NOT NULL,
            data_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sync_changelog (
            change_id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            version INTEGER NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL,
            changed_by TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS device_states (
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            last_sync_at TEXT,
            last_sync_version INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, device_id),
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
    ''')
    
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_sync_items_user ON sync_items(user_id, item_type)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_changelog_user ON sync_changelog(user_id, change_id)')
    
    conn.commit()
    conn.close()


init_sync_db()


def get_sync_db():
    conn = sqlite3.connect(SYNC_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000).hex()


def generate_token():
    return secrets.token_urlsafe(64)


def compute_data_hash(encrypted_data, iv, tag):
    h = hashlib.sha256()
    if isinstance(encrypted_data, (bytes, bytearray)):
        h.update(encrypted_data)
    else:
        h.update(str(encrypted_data).encode('utf-8'))
    h.update(iv.encode('utf-8'))
    h.update(tag.encode('utf-8'))
    return h.hexdigest()


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': '未提供认证令牌'}), 401
        
        token = auth_header[7:]
        conn = get_sync_db()
        try:
            cursor = conn.cursor()
            cursor.execute('SELECT * FROM sessions WHERE token = ?', (token,))
            session = cursor.fetchone()
            
            if not session:
                return jsonify({'success': False, 'error': '无效的认证令牌'}), 401
            
            if datetime.fromisoformat(session['expires_at']) < datetime.utcnow():
                cursor.execute('DELETE FROM sessions WHERE token = ?', (token,))
                conn.commit()
                return jsonify({'success': False, 'error': '认证令牌已过期'}), 401
            
            request.user_id = session['user_id']
            request.device_id = session['device_id']
            return f(*args, **kwargs)
        finally:
            conn.close()
    
    return decorated


def load_fonts_db():
    db_path = os.path.join(FONTS_FOLDER, 'fonts.json')
    if os.path.exists(db_path):
        try:
            with open(db_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return {}
    return {}


def save_fonts_db():
    db_path = os.path.join(FONTS_FOLDER, 'fonts.json')
    with open(db_path, 'w', encoding='utf-8') as f:
        json.dump(fonts_db, f, ensure_ascii=False, indent=2)


fonts_db = load_fonts_db()


def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def seeded_random(seed):
    import math
    x = math.sin(seed * 9999) * 10000
    return x - math.floor(x)


def add_paper_texture(img, paper_color, seed):
    import random
    random.seed(seed)
    width, height = img.size
    pixels = img.load()
    paper_rgb = hex_to_rgb(paper_color)
    
    for i in range(0, width, 2):
        for j in range(0, height, 2):
            if random.random() < 0.3:
                noise = random.randint(-10, 10)
                r, g, b, a = pixels[i, j]
                pixels[i, j] = (
                    max(0, min(255, r + noise)),
                    max(0, min(255, g + noise)),
                    max(0, min(255, b + noise)),
                    a
                )
    
    return img


def render_text_to_image(text, options, font_path=None):
    import math
    import random
    
    page_width = options.get('pageWidth', 800)
    page_height = options.get('pageHeight', 1150)
    padding = options.get('padding', 60)
    font_size = options.get('fontSize', 32)
    char_spacing = options.get('charSpacing', 2)
    line_height_ratio = options.get('lineHeight', 1.8)
    slant_angle = options.get('slantAngle', 0)
    ink_density = options.get('inkDensity', 80)
    random_offset = options.get('randomOffset', 3)
    stroke_noise = options.get('strokeNoise', 30)
    paper_color = options.get('paperColor', '#faf8f0')
    ink_color = options.get('inkColor', '#2c2c2c')
    weight = options.get('weight', 'normal')
    seed = options.get('seed', time.time())
    
    random.seed(seed)
    
    content_width = page_width - padding * 2
    content_height = page_height - padding * 2
    line_height = int(font_size * line_height_ratio)
    
    if font_path and os.path.exists(font_path):
        try:
            font = ImageFont.truetype(font_path, font_size)
        except Exception as e:
            print(f"字体加载失败: {e}")
            font = ImageFont.load_default()
    else:
        font = ImageFont.load_default()
    
    paragraphs = text.split('\n')
    lines = []
    
    for paragraph in paragraphs:
        if not paragraph:
            lines.append('')
            continue
        
        current_line = ''
        current_width = 0
        
        for char in paragraph:
            try:
                bbox = font.getbbox(char)
                char_width = bbox[2] - bbox[0] + char_spacing
            except:
                char_width = font_size * 0.6 + char_spacing
            
            if current_width + char_width > content_width and current_line:
                lines.append(current_line)
                current_line = char
                current_width = char_width
            else:
                current_line += char
                current_width += char_width
        
        if current_line:
            lines.append(current_line)
    
    lines_per_page = max(1, content_height // line_height)
    pages = [lines[i:i + lines_per_page] for i in range(0, len(lines), lines_per_page)]
    
    if not pages:
        pages = [[]]
    
    result_pages = []
    ink_rgb = hex_to_rgb(ink_color)
    paper_rgb = hex_to_rgb(paper_color)
    
    for page_idx, page_lines in enumerate(pages):
        img = Image.new('RGBA', (page_width, page_height), (*paper_rgb, 255))
        
        img = add_paper_texture(img, paper_color, seed + page_idx)
        
        draw = ImageDraw.Draw(img)
        
        y = padding
        char_index = 0
        
        for line_idx, line in enumerate(page_lines):
            x = padding
            
            for char_idx, char in enumerate(line):
                offset_x = random.uniform(-random_offset, random_offset)
                offset_y = random.uniform(-random_offset, random_offset)
                rotation = random.uniform(-2, 2)
                
                char_x = x + offset_x
                char_y = y + offset_y
                
                alpha = int(255 * (0.5 + (ink_density / 100) * 0.5))
                
                for layer in range(3):
                    layer_alpha = int(alpha * (0.6 + layer * 0.2))
                    layer_offset_x = random.uniform(-1, 1)
                    layer_offset_y = random.uniform(-1, 1)
                    
                    draw.text(
                        (char_x + layer_offset_x, char_y + layer_offset_y),
                        char,
                        font=font,
                        fill=(*ink_rgb, layer_alpha)
                    )
                
                try:
                    bbox = font.getbbox(char)
                    char_width = bbox[2] - bbox[0]
                except:
                    char_width = font_size * 0.6
                
                x += char_width + char_spacing
                char_index += 1
            
            y += line_height
        
        result_pages.append(img)
    
    return result_pages


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)


@app.route('/api/fonts', methods=['GET', 'HEAD'])
def list_fonts():
    fonts_list = [{
        'id': font_id,
        'name': font_info['name'],
        'fontFamily': font_info['fontFamily'],
        'path': font_info['path'],
        'size': font_info['size'],
        'uploadTime': font_info.get('uploadTime', '')
    } for font_id, font_info in fonts_db.items()]
    
    return jsonify({
        'success': True,
        'fonts': fonts_list
    })


@app.route('/api/fonts/<font_id>', methods=['DELETE'])
def delete_font(font_id):
    if font_id not in fonts_db:
        return jsonify({'success': False, 'error': '字体不存在'}), 404
    
    font_info = fonts_db[font_id]
    font_path = font_info['path']
    
    try:
        if os.path.exists(font_path):
            os.remove(font_path)
    except Exception as e:
        print(f"删除字体文件失败: {e}")
    
    del fonts_db[font_id]
    save_fonts_db()
    
    return jsonify({'success': True, 'message': '字体已删除'})


@app.route('/api/upload-font', methods=['POST'])
def upload_font():
    try:
        if 'font' not in request.files:
            return jsonify({'success': False, 'error': 'No font file provided'}), 400
        
        font_file = request.files['font']
        if font_file.filename == '':
            return jsonify({'success': False, 'error': 'No font file selected'}), 400
        
        allowed_extensions = {'.ttf', '.otf', '.woff', '.woff2'}
        filename = font_file.filename.lower()
        if not any(filename.endswith(ext) for ext in allowed_extensions):
            return jsonify({
                'success': False,
                'error': 'Only TTF, OTF, WOFF and WOFF2 files are supported'
            }), 400
        
        font_id = str(uuid.uuid4())
        safe_filename = secure_filename(font_file.filename)
        file_ext = os.path.splitext(safe_filename)[1]
        saved_filename = f"{font_id}{file_ext}"
        filepath = os.path.join(FONTS_FOLDER, saved_filename)
        
        font_file.save(filepath)
        
        font_size = os.path.getsize(filepath)
        
        font_family = f"Font_{font_id[:8]}"
        
        font_info = {
            'id': font_id,
            'name': font_file.filename,
            'fontFamily': font_family,
            'path': f"/uploads/fonts/{saved_filename}",
            'size': font_size,
            'uploadTime': datetime.now().isoformat()
        }
        
        fonts_db[font_id] = font_info
        save_fonts_db()
        
        return jsonify({
            'success': True,
            'fontId': font_id,
            'fontFamily': font_family,
            'fontPath': font_info['path'],
            'fontName': font_file.filename
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/uploads/fonts/<filename>')
def serve_font(filename):
    return send_from_directory(FONTS_FOLDER, filename)


@app.route('/api/generate', methods=['POST'])
def generate():
    try:
        data = request.json
        text = data.get('text', '')
        options = data.get('options', {})
        font_id = options.get('fontId')
        
        font_path = None
        if font_id and font_id in fonts_db:
            font_path = fonts_db[font_id]['path'].replace('/uploads/fonts/', '')
            font_path = os.path.join(FONTS_FOLDER, font_path)
        
        pages = render_text_to_image(text, options, font_path)
        
        result = []
        for i, page_img in enumerate(pages):
            buffer = io.BytesIO()
            page_img.save(buffer, format='PNG')
            buffer.seek(0)
            import base64
            img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
            result.append({
                'page': i + 1,
                'image': f'data:image/png;base64,{img_base64}'
            })
        
        return jsonify({
            'success': True,
            'pageCount': len(pages),
            'pages': result
        })
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/generate-async', methods=['POST'])
def generate_async():
    try:
        data = request.json
        task_id = str(uuid.uuid4())
        
        task = {
            'id': task_id,
            'status': 'pending',
            'createdAt': datetime.now().isoformat(),
            'data': data
        }
        
        with tasks_lock:
            tasks_db[task_id] = task
        
        process_task(task_id)
        
        return jsonify({
            'success': True,
            'taskId': task_id,
            'status': 'pending'
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


def process_task(task_id):
    def worker():
        try:
            with tasks_lock:
                task = tasks_db.get(task_id)
                if not task:
                    return
                
                task['status'] = 'processing'
                task['startedAt'] = datetime.now().isoformat()
            
            data = task['data']
            text = data.get('text', '')
            options = data.get('options', {})
            font_id = options.get('fontId')
            
            font_path = None
            if font_id and font_id in fonts_db:
                font_path = fonts_db[font_id]['path'].replace('/uploads/fonts/', '')
                font_path = os.path.join(FONTS_FOLDER, font_path)
            
            pages = render_text_to_image(text, options, font_path)
            
            output_files = []
            for i, page_img in enumerate(pages):
                output_filename = f"{task_id}_page_{i+1}.png"
                output_path = os.path.join(OUTPUT_FOLDER, output_filename)
                page_img.save(output_path, 'PNG')
                output_files.append({
                    'page': i + 1,
                    'url': f"/output/{output_filename}"
                })
            
            with tasks_lock:
                task['status'] = 'completed'
                task['completedAt'] = datetime.now().isoformat()
                task['result'] = {
                    'pageCount': len(pages),
                    'files': output_files
                }
        
        except Exception as e:
            with tasks_lock:
                task = tasks_db.get(task_id)
                if task:
                    task['status'] = 'failed'
                    task['error'] = str(e)
    
    thread = threading.Thread(target=worker)
    thread.daemon = True
    thread.start()


@app.route('/api/tasks/<task_id>', methods=['GET'])
def get_task_status(task_id):
    with tasks_lock:
        task = tasks_db.get(task_id)
    
    if not task:
        return jsonify({'success': False, 'error': 'Task not found'}), 404
    
    return jsonify({
        'success': True,
        'taskId': task_id,
        'status': task['status'],
        'createdAt': task.get('createdAt'),
        'startedAt': task.get('startedAt'),
        'completedAt': task.get('completedAt'),
        'result': task.get('result'),
        'error': task.get('error')
    })


@app.route('/output/<filename>')
def serve_output(filename):
    return send_from_directory(OUTPUT_FOLDER, filename)


@app.route('/api/export-long-image', methods=['POST'])
def export_long_image():
    try:
        data = request.json
        text = data.get('text', '')
        options = data.get('options', {})
        font_id = options.get('fontId')
        
        font_path = None
        if font_id and font_id in fonts_db:
            font_path = fonts_db[font_id]['path'].replace('/uploads/fonts/', '')
            font_path = os.path.join(FONTS_FOLDER, font_path)
        
        pages = render_text_to_image(text, options, font_path)
        
        total_height = sum(img.height for img in pages)
        width = pages[0].width if pages else 800
        
        long_img = Image.new('RGBA', (width, total_height), (*hex_to_rgb(options.get('paperColor', '#faf8f0')), 255))
        
        y_offset = 0
        for page_img in pages:
            long_img.paste(page_img, (0, y_offset))
            y_offset += page_img.height
        
        buffer = io.BytesIO()
        long_img.save(buffer, format='PNG')
        buffer.seek(0)
        
        return send_file(
            buffer,
            mimetype='image/png',
            as_attachment=True,
            download_name='handwriting_long.png'
        )
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/export-pages', methods=['POST'])
def export_pages():
    try:
        data = request.json
        text = data.get('text', '')
        options = data.get('options', {})
        page_index = data.get('page', 0)
        font_id = options.get('fontId')
        
        font_path = None
        if font_id and font_id in fonts_db:
            font_path = fonts_db[font_id]['path'].replace('/uploads/fonts/', '')
            font_path = os.path.join(FONTS_FOLDER, font_path)
        
        pages = render_text_to_image(text, options, font_path)
        
        if page_index < 0 or page_index >= len(pages):
            page_index = 0
        
        buffer = io.BytesIO()
        pages[page_index].save(buffer, format='PNG')
        buffer.seek(0)
        
        return send_file(
            buffer,
            mimetype='image/png',
            as_attachment=True,
            download_name=f'handwriting_page_{page_index + 1}.png'
        )
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/cleanup', methods=['POST'])
def cleanup_old_files():
    try:
        import glob
        
        now = time.time()
        cutoff = now - 24 * 60 * 60
        
        count = 0
        for filepath in glob.glob(os.path.join(OUTPUT_FOLDER, '*.png')):
            if os.path.getmtime(filepath) < cutoff:
                os.remove(filepath)
                count += 1
        
        with tasks_lock:
            old_tasks = [tid for tid, task in tasks_db.items() 
                          if task.get('completedAt') and 
                          (now - datetime.fromisoformat(task['completedAt']).timestamp()) > cutoff]
            for tid in old_tasks:
                del tasks_db[tid]
        
        return jsonify({
            'success': True,
            'deletedFiles': count,
            'deletedTasks': len(old_tasks)
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'success': True,
        'status': 'ok',
        'fontsCount': len(fonts_db),
        'tasksCount': len(tasks_db),
        'syncEnabled': True
    })


@app.route('/api/auth/register', methods=['POST'])
def register_user():
    try:
        data = request.json
        username = data.get('username', '').strip()
        password = data.get('password', '')
        device_id = data.get('deviceId', '')
        
        if not username or len(username) < 3:
            return jsonify({'success': False, 'error': '用户名至少3个字符'}), 400
        if not password or len(password) < 6:
            return jsonify({'success': False, 'error': '密码至少6个字符'}), 400
        if not device_id:
            device_id = str(uuid.uuid4())
        
        salt = secrets.token_hex(16)
        password_hash = hash_password(password, salt)
        user_id = str(uuid.uuid4())
        created_at = datetime.utcnow().isoformat()
        
        kdf_params = json.dumps({
            'algorithm': 'PBKDF2-HMAC-SHA256',
            'iterations': 100000,
            'keyLength': 32,
            'salt': salt
        })
        
        conn = get_sync_db()
        try:
            cursor = conn.cursor()
            cursor.execute('SELECT user_id FROM users WHERE username = ?', (username,))
            if cursor.fetchone():
                return jsonify({'success': False, 'error': '用户名已存在'}), 409
            
            cursor.execute(
                'INSERT INTO users (user_id, username, password_hash, salt, created_at, kdf_params) VALUES (?, ?, ?, ?, ?, ?)',
                (user_id, username, password_hash, salt, created_at, kdf_params)
            )
            
            token = generate_token()
            expires_at = (datetime.utcnow() + timedelta(hours=TOKEN_EXPIRY_HOURS)).isoformat()
            
            cursor.execute(
                'INSERT INTO sessions (token, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                (token, user_id, device_id, created_at, expires_at)
            )
            
            cursor.execute(
                'INSERT OR IGNORE INTO device_states (user_id, device_id, last_sync_version) VALUES (?, ?, 0)',
                (user_id, device_id)
            )
            
            conn.commit()
            
            return jsonify({
                'success': True,
                'userId': user_id,
                'username': username,
                'token': token,
                'deviceId': device_id,
                'kdfParams': json.loads(kdf_params),
                'expiresAt': expires_at
            })
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/auth/login', methods=['POST'])
def login_user():
    try:
        data = request.json
        username = data.get('username', '').strip()
        password = data.get('password', '')
        device_id = data.get('deviceId', '')
        
        if not username or not password:
            return jsonify({'success': False, 'error': '用户名和密码不能为空'}), 400
        if not device_id:
            device_id = str(uuid.uuid4())
        
        conn = get_sync_db()
        try:
            cursor = conn.cursor()
            cursor.execute('SELECT * FROM users WHERE username = ?', (username,))
            user = cursor.fetchone()
            
            if not user:
                return jsonify({'success': False, 'error': '用户名或密码错误'}), 401
            
            password_hash = hash_password(password, user['salt'])
            if password_hash != user['password_hash']:
                return jsonify({'success': False, 'error': '用户名或密码错误'}), 401
            
            token = generate_token()
            created_at = datetime.utcnow().isoformat()
            expires_at = (datetime.utcnow() + timedelta(hours=TOKEN_EXPIRY_HOURS)).isoformat()
            
            cursor.execute(
                'INSERT INTO sessions (token, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                (token, user['user_id'], device_id, created_at, expires_at)
            )
            
            cursor.execute(
                'INSERT OR IGNORE INTO device_states (user_id, device_id, last_sync_version) VALUES (?, ?, 0)',
                (user['user_id'], device_id)
            )
            
            conn.commit()
            
            return jsonify({
                'success': True,
                'userId': user['user_id'],
                'username': username,
                'token': token,
                'deviceId': device_id,
                'kdfParams': json.loads(user['kdf_params']),
                'expiresAt': expires_at
            })
        finally:
            conn.close()
    
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/auth/logout', methods=['POST'])
@require_auth
def logout_user():
    auth_header = request.headers.get('Authorization', '')
    token = auth_header[7:]
    
    conn = get_sync_db()
    try:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM sessions WHERE token = ?', (token,))
        conn.commit()
        return jsonify({'success': True, 'message': '已登出'})
    finally:
        conn.close()


@app.route('/api/auth/kdf-params', methods=['GET'])
def get_kdf_params():
    username = request.args.get('username', '').strip()
    if not username:
        default_salt = secrets.token_hex(16)
        return jsonify({
            'success': True,
            'kdfParams': {
                'algorithm': 'PBKDF2-HMAC-SHA256',
                'iterations': 100000,
                'keyLength': 32,
                'salt': default_salt
            }
        })
    
    conn = get_sync_db()
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT kdf_params FROM users WHERE username = ?', (username,))
        user = cursor.fetchone()
        
        if user:
            return jsonify({
                'success': True,
                'kdfParams': json.loads(user['kdf_params'])
            })
        
        default_salt = secrets.token_hex(16)
        return jsonify({
            'success': True,
            'kdfParams': {
                'algorithm': 'PBKDF2-HMAC-SHA256',
                'iterations': 100000,
                'keyLength': 32,
                'salt': default_salt
            }
        })
    finally:
        conn.close()


@app.route('/api/sync/pull', methods=['POST'])
@require_auth
def sync_pull():
    try:
        data = request.json or {}
        last_sync_version = data.get('lastSyncVersion', 0)
        item_types = data.get('itemTypes')
        
        user_id = request.user_id
        device_id = request.device_id
        
        conn = get_sync_db()
        try:
            cursor = conn.cursor()
            
            cursor.execute('SELECT MAX(change_id) as max_change_id FROM sync_changelog WHERE user_id = ?', (user_id,))
            max_change_id_row = cursor.fetchone()
            server_version = max_change_id_row['max_change_id'] if max_change_id_row and max_change_id_row['max_change_id'] else 0
            
            query = '''
                SELECT sc.change_id, sc.item_id, sc.item_type, sc.version, sc.operation, sc.changed_at, sc.changed_by,
                       si.encrypted_data, si.iv, si.tag, si.data_hash, si.is_deleted, si.updated_at
                FROM sync_changelog sc
                LEFT JOIN sync_items si ON sc.item_id = si.item_id
                WHERE sc.user_id = ? AND sc.change_id > ?
            '''
            params = [user_id, last_sync_version]
            
            if item_types:
                placeholders = ','.join(['?'] * len(item_types))
                query += f' AND sc.item_type IN ({placeholders})'
                params.extend(item_types)
            
            query += ' ORDER BY sc.change_id ASC'
            
            cursor.execute(query, params)
            changes = []
            for row in cursor.fetchall():
                change = {
                    'changeId': row['change_id'],
                    'itemId': row['item_id'],
                    'itemType': row['item_type'],
                    'version': row['version'],
                    'operation': row['operation'],
                    'changedAt': row['changed_at'],
                    'changedBy': row['changed_by'],
                    'isDeleted': bool(row['is_deleted']) if row['is_deleted'] is not None else False
                }
                
                if row['operation'] != 'DELETE' and row['encrypted_data'] is not None:
                    if isinstance(row['encrypted_data'], (bytes, bytearray)):
                        data_b64 = base64.b64encode(row['encrypted_data']).decode('utf-8')
                    else:
                        data_b64 = base64.b64encode(str(row['encrypted_data']).encode('utf-8')).decode('utf-8')
                    change.update({
                        'encryptedData': data_b64,
                        'iv': row['iv'],
                        'tag': row['tag'],
                        'dataHash': row['data_hash']
                    })
                
                changes.append(change)
            
            cursor.execute('''
                UPDATE device_states SET last_sync_at = ?, last_sync_version = ?
                WHERE user_id = ? AND device_id = ?
            ''', (datetime.utcnow().isoformat(), server_version, user_id, device_id))
            conn.commit()
            
            return jsonify({
                'success': True,
                'serverVersion': server_version,
                'changes': changes,
                'changeCount': len(changes)
            })
        finally:
            conn.close()
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/sync/push', methods=['POST'])
@require_auth
def sync_push():
    try:
        data = request.json
        changes = data.get('changes', [])
        client_version = data.get('clientVersion', 0)
        
        if not isinstance(changes, list):
            return jsonify({'success': False, 'error': 'changes必须是数组'}), 400
        
        user_id = request.user_id
        device_id = request.device_id
        now = datetime.utcnow().isoformat()
        
        conn = get_sync_db()
        try:
            cursor = conn.cursor()
            
            cursor.execute('SELECT MAX(change_id) as max_change_id FROM sync_changelog WHERE user_id = ?', (user_id,))
            max_change_id_row = cursor.fetchone()
            current_version = max_change_id_row['max_change_id'] if max_change_id_row and max_change_id_row['max_change_id'] else 0
            
            conflicts = []
            applied_changes = []
            
            for change in changes:
                item_id = change.get('itemId')
                item_type = change.get('itemType')
                operation = change.get('operation', 'PUT')
                base_version = change.get('baseVersion', 0)
                
                if not item_id or not item_type:
                    continue
                
                cursor.execute('SELECT version FROM sync_items WHERE item_id = ? AND user_id = ?', (item_id, user_id))
                existing = cursor.fetchone()
                
                server_current_version = existing['version'] if existing else 0
                
                if operation != 'CREATE' and server_current_version > base_version:
                    cursor.execute('SELECT encrypted_data, iv, tag, data_hash, is_deleted, updated_at, updated_by, version FROM sync_items WHERE item_id = ?', (item_id,))
                    conflict_item = cursor.fetchone()
                    if conflict_item:
                        enc_data = conflict_item['encrypted_data']
                        if isinstance(enc_data, (bytes, bytearray)):
                            data_b64 = base64.b64encode(enc_data).decode('utf-8')
                        else:
                            data_b64 = base64.b64encode(str(enc_data).encode('utf-8')).decode('utf-8')
                        conflicts.append({
                            'itemId': item_id,
                            'itemType': item_type,
                            'serverVersion': conflict_item['version'],
                            'clientBaseVersion': base_version,
                            'serverEncryptedData': data_b64,
                            'serverIv': conflict_item['iv'],
                            'serverTag': conflict_item['tag'],
                            'serverDataHash': conflict_item['data_hash'],
                            'serverUpdatedAt': conflict_item['updated_at'],
                            'serverUpdatedBy': conflict_item['updated_by'],
                            'serverIsDeleted': bool(conflict_item['is_deleted']),
                            'resolutionStrategy': 'LWW'
                        })
                    continue
                
                if operation == 'DELETE':
                    if existing:
                        new_version = server_current_version + 1
                        cursor.execute('''
                            UPDATE sync_items SET version = ?, is_deleted = 1, updated_at = ?, updated_by = ?
                            WHERE item_id = ?
                        ''', (new_version, now, device_id, item_id))
                        
                        cursor.execute('''
                            INSERT INTO sync_changelog (item_id, user_id, item_type, version, operation, changed_at, changed_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        ''', (item_id, user_id, item_type, new_version, 'DELETE', now, device_id))
                        
                        applied_changes.append({'itemId': item_id, 'operation': 'DELETE', 'newVersion': new_version})
                
                elif operation in ('CREATE', 'PUT', 'UPDATE'):
                    encrypted_data_b64 = change.get('encryptedData')
                    iv = change.get('iv')
                    tag = change.get('tag')
                    client_data_hash = change.get('dataHash')
                    
                    if not all([encrypted_data_b64, iv, tag]):
                        continue
                    
                    try:
                        encrypted_data = base64.b64decode(encrypted_data_b64)
                    except:
                        continue
                    
                    actual_hash = compute_data_hash(encrypted_data, iv, tag)
                    
                    if existing:
                        new_version = server_current_version + 1
                        cursor.execute('''
                            UPDATE sync_items SET version = ?, encrypted_data = ?, iv = ?, tag = ?, data_hash = ?,
                                                 updated_at = ?, updated_by = ?, is_deleted = 0
                            WHERE item_id = ?
                        ''', (new_version, encrypted_data, iv, tag, actual_hash, now, device_id, item_id))
                    else:
                        new_version = 1
                        cursor.execute('''
                            INSERT INTO sync_items (item_id, user_id, item_type, version, encrypted_data, iv, tag,
                                                    data_hash, updated_at, updated_by, is_deleted)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                        ''', (item_id, user_id, item_type, new_version, encrypted_data, iv, tag, actual_hash, now, device_id))
                    
                    op = 'CREATE' if not existing else 'UPDATE'
                    cursor.execute('''
                        INSERT INTO sync_changelog (item_id, user_id, item_type, version, operation, changed_at, changed_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''', (item_id, user_id, item_type, new_version, op, now, device_id))
                    
                    applied_changes.append({'itemId': item_id, 'operation': op, 'newVersion': new_version})
            
            cursor.execute('SELECT MAX(change_id) as max_change_id FROM sync_changelog WHERE user_id = ?', (user_id,))
            final_version_row = cursor.fetchone()
            final_version = final_version_row['max_change_id'] if final_version_row and final_version_row['max_change_id'] else 0
            
            cursor.execute('''
                UPDATE device_states SET last_sync_at = ?, last_sync_version = ?
                WHERE user_id = ? AND device_id = ?
            ''', (now, final_version, user_id, device_id))
            
            conn.commit()
            
            return jsonify({
                'success': True,
                'serverVersion': final_version,
                'appliedChanges': applied_changes,
                'appliedCount': len(applied_changes),
                'conflicts': conflicts,
                'conflictCount': len(conflicts)
            })
        
        except Exception as e:
            conn.rollback()
            raise
        finally:
            conn.close()
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/sync/status', methods=['GET'])
@require_auth
def sync_status():
    user_id = request.user_id
    device_id = request.device_id
    
    conn = get_sync_db()
    try:
        cursor = conn.cursor()
        
        cursor.execute('SELECT MAX(change_id) as max_change_id FROM sync_changelog WHERE user_id = ?', (user_id,))
        version_row = cursor.fetchone()
        server_version = version_row['max_change_id'] if version_row and version_row['max_change_id'] else 0
        
        cursor.execute('SELECT last_sync_version FROM device_states WHERE user_id = ? AND device_id = ?', (user_id, device_id))
        device_row = cursor.fetchone()
        last_sync_version = device_row['last_sync_version'] if device_row else 0
        
        counts = {}
        for item_type in ['fonts', 'presets', 'history']:
            cursor.execute('SELECT COUNT(*) as cnt FROM sync_items WHERE user_id = ? AND item_type = ? AND is_deleted = 0',
                          (user_id, item_type))
            row = cursor.fetchone()
            counts[item_type] = row['cnt'] if row else 0
        
        return jsonify({
            'success': True,
            'serverVersion': server_version,
            'deviceLastSyncVersion': last_sync_version,
            'isInSync': server_version == last_sync_version,
            'pendingChanges': server_version - last_sync_version,
            'itemCounts': counts
        })
    finally:
        conn.close()


@app.route('/api/sync/resolve-conflict', methods=['POST'])
@require_auth
def resolve_conflict():
    try:
        data = request.json
        item_id = data.get('itemId')
        resolution = data.get('resolution', 'CLIENT')
        encrypted_data_b64 = data.get('encryptedData')
        iv = data.get('iv')
        tag = data.get('tag')
        
        if not item_id:
            return jsonify({'success': False, 'error': '缺少itemId'}), 400
        
        user_id = request.user_id
        device_id = request.device_id
        now = datetime.utcnow().isoformat()
        
        conn = get_sync_db()
        try:
            cursor = conn.cursor()
            
            cursor.execute('SELECT version FROM sync_items WHERE item_id = ? AND user_id = ?', (item_id, user_id))
            existing = cursor.fetchone()
            
            if not existing:
                return jsonify({'success': False, 'error': '项目不存在'}), 404
            
            if resolution == 'SERVER':
                new_version = existing['version'] + 1
                cursor.execute('''
                    INSERT INTO sync_changelog (item_id, user_id, item_type, version, operation, changed_at, changed_by)
                    SELECT item_id, user_id, item_type, ?, 'RESOLVE_SERVER', ?, ?
                    FROM sync_items WHERE item_id = ?
                ''', (new_version, now, device_id, item_id))
            else:
                if not all([encrypted_data_b64, iv, tag]):
                    return jsonify({'success': False, 'error': '客户端解析需要加密数据'}), 400
                
                try:
                    encrypted_data = base64.b64decode(encrypted_data_b64)
                except:
                    return jsonify({'success': False, 'error': '加密数据格式错误'}), 400
                
                actual_hash = compute_data_hash(encrypted_data, iv, tag)
                new_version = existing['version'] + 1
                
                cursor.execute('''
                    UPDATE sync_items SET version = ?, encrypted_data = ?, iv = ?, tag = ?, data_hash = ?,
                                         updated_at = ?, updated_by = ?, is_deleted = 0
                    WHERE item_id = ?
                ''', (new_version, encrypted_data, iv, tag, actual_hash, now, device_id, item_id))
                
                cursor.execute('''
                    INSERT INTO sync_changelog (item_id, user_id, item_type, version, operation, changed_at, changed_by)
                    SELECT item_id, user_id, item_type, ?, 'RESOLVE_CLIENT', ?, ?
                    FROM sync_items WHERE item_id = ?
                ''', (new_version, now, device_id, item_id))
            
            cursor.execute('SELECT MAX(change_id) as max_change_id FROM sync_changelog WHERE user_id = ?', (user_id,))
            version_row = cursor.fetchone()
            final_version = version_row['max_change_id'] if version_row and version_row['max_change_id'] else 0
            
            conn.commit()
            
            return jsonify({
                'success': True,
                'itemId': item_id,
                'resolution': resolution,
                'newVersion': new_version,
                'serverVersion': final_version
            })
        except Exception as e:
            conn.rollback()
            raise
        finally:
            conn.close()
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=True)
