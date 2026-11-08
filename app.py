from fastapi import FastAPI, HTTPException, UploadFile, File, Header, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi import Request
import io, time, socket, unicodedata, math
from urllib.parse import urlsplit
import qrcode
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import sqlite3, secrets, json, shutil, os, asyncio

BASE = Path(__file__).resolve().parent
DB = BASE / 'quizcontrol.db'
MEDIA = BASE / 'media'
STATIC = BASE / 'static'
MEDIA.mkdir(exist_ok=True)
CONFIG = BASE / 'config.json'
if CONFIG.exists():
    config = json.loads(CONFIG.read_text('utf-8'))
else:
    config = {'admin_key': secrets.token_urlsafe(12)}
    CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2), 'utf-8')
ADMIN_KEY = config['admin_key']

app = FastAPI(title='QuizControl', version='0.6.4')
app.mount('/static', StaticFiles(directory=STATIC), name='static')
app.mount('/media', StaticFiles(directory=MEDIA), name='media')

class Payload(BaseModel):
    action: str
    data: dict = {}
class Login(BaseModel):
    password: str
class Answer(BaseModel):
    participant_id: int
    text: str

clients = set()
admin_clients = set()

def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c

def columns(c, table):
    return {r['name'] for r in c.execute(f'PRAGMA table_info({table})')}

def add_column(c, table, name, definition):
    if name not in columns(c, table):
        c.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')

def init_db():
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'team', allow_answers INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', points INTEGER NOT NULL DEFAULT 1, media TEXT NOT NULL DEFAULT '', media_type TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS participants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL, points INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL, question_id INTEGER, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL, game_id INTEGER NOT NULL, emoji TEXT NOT NULL, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS round_progress (game_id INTEGER NOT NULL, round_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', started_at REAL, finished_at REAL, PRIMARY KEY(game_id,round_id));
        ''')
        # Safe, additive migrations: existing MVP data is preserved.
        add_column(c, 'games', 'game_type', "TEXT NOT NULL DEFAULT 'mixed'")
        add_column(c, 'games', 'description', "TEXT NOT NULL DEFAULT ''")
        add_column(c, 'games', 'show_scoreboard', 'INTEGER NOT NULL DEFAULT 1')
        add_column(c, 'games', 'allow_registration', 'INTEGER NOT NULL DEFAULT 1')
        add_column(c, 'rounds', 'allow_answers', 'INTEGER NOT NULL DEFAULT -1') # -1 inherits game setting
        add_column(c, 'rounds', 'round_type', "TEXT NOT NULL DEFAULT 'standard'")
        add_column(c, 'rounds', 'instructions', "TEXT NOT NULL DEFAULT ''")
        add_column(c, 'questions', 'question_type', "TEXT NOT NULL DEFAULT 'text'")
        add_column(c, 'questions', 'options_json', "TEXT NOT NULL DEFAULT '[]'")
        add_column(c, 'questions', 'correct_answer', "TEXT NOT NULL DEFAULT ''")
        add_column(c, 'questions', 'explanation', "TEXT NOT NULL DEFAULT ''")
        add_column(c, 'questions', 'time_limit', 'INTEGER NOT NULL DEFAULT 0')
        add_column(c, 'questions', 'required', 'INTEGER NOT NULL DEFAULT 0')
        add_column(c, 'participants', 'game_id', 'INTEGER NOT NULL DEFAULT 0')
        add_column(c, 'participants', 'last_seen', 'REAL NOT NULL DEFAULT 0')
        add_column(c, 'answers', 'is_correct', 'INTEGER')
        add_column(c, 'answers', 'awarded_points', 'INTEGER NOT NULL DEFAULT 0')
        add_column(c, 'scores', 'question_id', 'INTEGER')
        add_column(c, 'scores', 'round_id', 'INTEGER')
        if c.execute('SELECT COUNT(*) n FROM games').fetchone()['n'] == 0:
            cur = c.execute("INSERT INTO games(title,format,allow_answers,status,game_type) VALUES(?,?,?,?,?)", ('Демонстрационная игра','team',0,'draft','mixed'))
            gid = cur.lastrowid
            c.execute('INSERT INTO rounds(game_id,title,position) VALUES(?,?,1)',(gid,'Раунд 1'))
        first_game = c.execute('SELECT id FROM games ORDER BY id LIMIT 1').fetchone()['id']
        c.execute('UPDATE participants SET game_id=? WHERE game_id=0', (first_game,))
        if c.execute("SELECT value FROM settings WHERE key='current_game'").fetchone() is None:
            c.execute("INSERT INTO settings(key,value) VALUES('current_game',?)",(str(first_game),))
        for key, value in [('current_question','0'),('screen_mode','welcome'),('question_started_at','0'),('answers_revealed','0'),('timer_frozen_remaining',''),('active_round_id','0'),('public_url',''),('media_control','{}'),('screen_media','{}'),('screen_mode_before_media','')]:
            if c.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone() is None:
                c.execute('INSERT INTO settings(key,value) VALUES(?,?)',(key,value))

init_db()

def admin(key):
    if not key or not secrets.compare_digest(key, ADMIN_KEY):
        raise HTTPException(401, 'Нужен пароль организатора')

def current_game_id(c):
    row = c.execute("SELECT value FROM settings WHERE key='current_game'").fetchone()
    return int(row['value']) if row else 1

def normalize_answer(value):
    value=unicodedata.normalize('NFKC', str(value or '')).casefold().strip()
    return ' '.join(value.split())

def answers_match(question_type, submitted, correct):
    if not str(correct or '').strip(): return False
    if question_type == 'multiple_choice':
        left={normalize_answer(x) for x in str(submitted).split(',') if normalize_answer(x)}
        right={normalize_answer(x) for x in str(correct).split(',') if normalize_answer(x)}
        return bool(right) and left == right
    return normalize_answer(submitted) == normalize_answer(correct)

def finalize_question(c, question_id):
    q=c.execute('SELECT * FROM questions WHERE id=?',(question_id,)).fetchone()
    if not q: return
    rows=c.execute('SELECT a.* FROM answers a WHERE a.question_id=? AND a.is_correct IS NULL AND a.id=(SELECT MAX(b.id) FROM answers b WHERE b.question_id=a.question_id AND b.participant_id=a.participant_id)',(question_id,)).fetchall()
    for answer_row in rows:
        correct=answers_match(q['question_type'],answer_row['text'],q['correct_answer'])
        points=int(q['points']) if correct else 0
        c.execute('UPDATE answers SET is_correct=?,awarded_points=? WHERE id=?',(1 if correct else 0,points,answer_row['id']))
        if correct and points:
            c.execute('INSERT INTO scores(participant_id,points,reason,question_id,round_id) VALUES(?,?,?,?,?)',(answer_row['participant_id'],points,'Правильный ответ: '+(q['title'] or 'вопрос'),question_id,q['round_id']))


def freeze_question_timer(c, question_id):
    # Freeze the exact number of seconds left when the answer is revealed.
    q=c.execute('SELECT time_limit FROM questions WHERE id=?',(question_id,)).fetchone()
    started_row=c.execute("SELECT value FROM settings WHERE key='question_started_at'").fetchone()
    started=float(started_row['value'] or 0) if started_row else 0
    limit=int(q['time_limit'] or 0) if q else 0
    remaining=max(0, math.ceil(limit-(time.time()-started))) if limit>0 and started else 0
    c.execute("UPDATE settings SET value=? WHERE key='timer_frozen_remaining'",(str(remaining),))
    return remaining

def get_screen_media(c):
    row=c.execute("SELECT value FROM settings WHERE key='screen_media'").fetchone()
    try: value=json.loads(row['value'] or '{}') if row else {}
    except (TypeError,ValueError): value={}
    return value if isinstance(value,dict) and value.get('url') else None


def get_media_control(c):
    row=c.execute("SELECT value FROM settings WHERE key='media_control'").fetchone()
    try:
        value=json.loads(row['value'] or '{}') if row else {}
    except (TypeError, ValueError):
        value={}
    if not isinstance(value,dict): value={}
    return {
        'sequence':int(value.get('sequence') or 0),
        'scope':str(value.get('scope') or 'question'),
        'question_id':int(value.get('question_id') or 0),
        'url':str(value.get('url') or ''),
        'type':str(value.get('type') or ''),
        'action':str(value.get('action') or 'stopped'),
        'position':max(0.0,float(value.get('position') or 0)),
        'updated_at':float(value.get('updated_at') or 0)
    }


def write_media_control(c, value):
    c.execute("INSERT INTO settings(key,value) VALUES('media_control',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(value,ensure_ascii=False),))


def set_media_control(c, command):
    mode=c.execute("SELECT value FROM settings WHERE key='screen_mode'").fetchone()['value']
    if mode=='media_fullscreen':
        target=get_screen_media(c)
        if not target or target.get('type') not in ('audio','video'):
            raise HTTPException(400,'Для этого медиафайла управление воспроизведением недоступно')
        scope='screen'; qid=0; url=target['url']; media_type=target['type']
    else:
        qid=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
        q=c.execute('SELECT id,media,media_type FROM questions WHERE id=?',(qid,)).fetchone() if qid else None
        if not q or not q['media'] or q['media_type'] not in ('audio','video'):
            raise HTTPException(400,'У текущего вопроса нет аудио- или видеофайла')
        scope='question'; url=q['media']; media_type=q['media_type']
    now=time.time(); old=get_media_control(c)
    same=old.get('scope')==scope and int(old.get('question_id') or 0)==qid and old.get('url')==url
    old_action=old.get('action'); old_position=float(old.get('position') or 0)
    if same and old_action=='playing': old_position=max(0.0,old_position+(now-float(old.get('updated_at') or now)))
    if command=='media_play':
        action='playing'; position=old_position if same and old_action in ('paused','playing') else 0.0
        if same and old_action=='playing': return old
    elif command=='media_pause':
        action='paused'; position=old_position if same else 0.0
        if same and old_action=='paused': return old
    elif command=='media_restart': action='playing'; position=0.0
    elif command=='media_stop': action='stopped'; position=0.0
    else: raise HTTPException(400,'Неизвестная команда медиаплеера')
    value={'sequence':old['sequence']+1,'scope':scope,'question_id':qid,'url':url,'type':media_type,'action':action,'position':round(position,3),'updated_at':now}
    write_media_control(c,value)
    return value


def show_screen_media(c, data):
    url=str(data.get('url') or '')
    if not url.startswith('/media/'):
        raise HTTPException(400,'Выберите файл из медиатеки')
    name=url[len('/media/'):]
    if not name or Path(name).name!=name or '/' in name or '\\' in name or name in ('.','..'):
        raise HTTPException(400,'Некорректный путь к медиафайлу')
    target=MEDIA/name
    if not target.is_file(): raise HTTPException(404,'Файл не найден в медиатеке')
    ext=target.suffix.lower()
    media_type='video' if ext in {'.mp4','.webm','.mov','.m4v'} else 'image' if ext in {'.jpg','.jpeg','.png','.gif','.webp'} else 'audio' if ext in {'.mp3','.wav','.ogg','.m4a','.aac','.flac'} else ''
    if media_type not in ('video','image'):
        raise HTTPException(400,'На весь экран можно вывести изображение или видео')
    now=time.time(); old=get_media_control(c)
    current_mode=c.execute("SELECT value FROM settings WHERE key='screen_mode'").fetchone()['value']
    if current_mode!='media_fullscreen':
        c.execute("UPDATE settings SET value=? WHERE key='screen_mode_before_media'",(current_mode,))
    value={'url':url,'type':media_type,'name':str(data.get('name') or name)}
    c.execute("UPDATE settings SET value=? WHERE key='screen_media'",(json.dumps(value,ensure_ascii=False),))
    c.execute("UPDATE settings SET value='media_fullscreen' WHERE key='screen_mode'")
    control={'sequence':old['sequence']+1,'scope':'screen','question_id':0,'url':url,'type':media_type,'action':'playing' if media_type=='video' else 'stopped','position':0.0,'updated_at':now}
    write_media_control(c,control)
    return value


def hide_screen_media(c):
    current_mode=c.execute("SELECT value FROM settings WHERE key='screen_mode'").fetchone()['value']
    if current_mode!='media_fullscreen': return
    old_mode=c.execute("SELECT value FROM settings WHERE key='screen_mode_before_media'").fetchone()['value'] or 'welcome'
    old=get_media_control(c); now=time.time()
    qid=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
    q=c.execute('SELECT media,media_type FROM questions WHERE id=?',(qid,)).fetchone() if qid else None
    control={'sequence':old['sequence']+1,'scope':'question','question_id':qid,'url':q['media'] if q else '', 'type':q['media_type'] if q else '', 'action':'stopped','position':0.0,'updated_at':now}
    write_media_control(c,control)
    c.execute("UPDATE settings SET value='{}' WHERE key='screen_media'")
    c.execute("UPDATE settings SET value='' WHERE key='screen_mode_before_media'")
    c.execute("UPDATE settings SET value=? WHERE key='screen_mode'",(old_mode,))


def clear_screen_media(c):
    if c.execute("SELECT value FROM settings WHERE key='screen_mode'").fetchone()['value']=='media_fullscreen':
        stop_media_control(c)
    c.execute("UPDATE settings SET value='{}' WHERE key='screen_media'")
    c.execute("UPDATE settings SET value='' WHERE key='screen_mode_before_media'")


def stop_media_control(c):
    old=get_media_control(c)
    value={**old,'action':'stopped','position':0.0,'updated_at':time.time(),'sequence':old['sequence']+1}
    c.execute("INSERT INTO settings(key,value) VALUES('media_control',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(value,ensure_ascii=False),))


def state(include_private=False):
    with db() as c:
        settings = {r['key']:r['value'] for r in c.execute('SELECT * FROM settings')}
        media_control=get_media_control(c)
        screen_media=get_screen_media(c)
        gid = int(settings.get('current_game','1'))
        game = c.execute('SELECT * FROM games WHERE id=?',(gid,)).fetchone()
        if not game:
            game = c.execute('SELECT * FROM games ORDER BY id DESC LIMIT 1').fetchone()
            gid = game['id'] if game else 0
        active_round_id = int(settings.get('active_round_id','0') or 0)
        rounds=[]; current_q=None; active_round=None
        if game:
            for r0 in c.execute('SELECT * FROM rounds WHERE game_id=? ORDER BY position,id',(gid,)):
                r=dict(r0)
                r['allow_answers_effective'] = bool(game['allow_answers']) if r['allow_answers'] == -1 else bool(r['allow_answers'])
                progress=c.execute('SELECT status,started_at,finished_at FROM round_progress WHERE game_id=? AND round_id=?',(gid,r['id'])).fetchone()
                r['progress_status']=progress['status'] if progress else 'pending'
                qs=[]
                for q0 in c.execute('SELECT * FROM questions WHERE round_id=? ORDER BY position,id',(r['id'],)):
                    q=dict(q0)
                    if not include_private:
                        q['correct_answer']=''; q['explanation']=''
                    try: q['options']=json.loads(q.get('options_json') or '[]')
                    except: q['options']=[]
                    qs.append(q)
                r['questions']=qs
                if r['id']==active_round_id: active_round=r
                rounds.append(r)
            qid=int(settings.get('current_question','0'))
            if qid:
                q=c.execute('SELECT q.*,r.title round_title,r.allow_answers round_allow_answers,g.allow_answers game_allow_answers FROM questions q JOIN rounds r ON q.round_id=r.id JOIN games g ON r.game_id=g.id WHERE q.id=?',(qid,)).fetchone()
                if q:
                    current_q=dict(q)
                    try: current_q['options']=json.loads(current_q.get('options_json') or '[]')
                    except: current_q['options']=[]
                    current_q['allow_answers_effective']=bool(current_q['game_allow_answers']) if current_q['round_allow_answers']==-1 else bool(current_q['round_allow_answers'])
        started_at=float(settings.get('question_started_at','0') or 0)
        revealed=settings.get('answers_revealed','0')=='1'
        remaining=None
        answer_stats=[]
        answer_count=0
        if current_q:
            limit=int(current_q.get('time_limit') or 0)
            if limit>0 and started_at:
                if revealed:
                    # Legacy revealed questions without a frozen value stay at zero.
                    frozen=settings.get('timer_frozen_remaining','')
                    remaining=max(0, int(float(frozen))) if frozen not in (None, '') else 0
                else:
                    elapsed=time.time()-started_at
                    remaining=max(0, math.ceil(limit-elapsed))
                    if elapsed>=limit:
                        revealed=True
                        remaining=0
                        c.execute("UPDATE settings SET value='1' WHERE key='answers_revealed'")
                        c.execute("UPDATE settings SET value='0' WHERE key='timer_frozen_remaining'")
                        settings['timer_frozen_remaining']='0'
                        finalize_question(c,current_q['id'])
            raw_answers=[x['text'] for x in c.execute('SELECT a.text FROM answers a WHERE a.question_id=? AND a.id=(SELECT MAX(b.id) FROM answers b WHERE b.question_id=a.question_id AND b.participant_id=a.participant_id)',(current_q['id'],)).fetchall()]
            answer_count=len(raw_answers)
            if current_q.get('question_type') in ('single_choice','true_false','multiple_choice'):
                opts=current_q.get('options') or []
                counts={str(option):0 for option in opts}
                for raw in raw_answers:
                    selected=[v.strip() for v in raw.split(',')] if current_q.get('question_type')=='multiple_choice' else [raw]
                    for value in set(selected):
                        if value in counts: counts[value]+=1
                answer_stats=[{'text':option,'count':count,'percent':round(count*100/answer_count) if answer_count else 0} for option,count in counts.items()]
            else:
                counts={}
                for raw in raw_answers: counts[raw]=counts.get(raw,0)+1
                answer_stats=[{'text':value,'count':count,'percent':round(count*100/answer_count) if answer_count else 0} for value,count in sorted(counts.items(),key=lambda x:(-x[1],x[0]))]
        if current_q and not include_private and not revealed:
            current_q['correct_answer']=''; current_q['explanation']=''
        round_points={}
        if active_round_id:
            for row in c.execute('SELECT participant_id,COALESCE(SUM(points),0) points FROM scores WHERE round_id=? GROUP BY participant_id',(active_round_id,)):
                round_points[int(row['participant_id'])]=int(row['points'])
        people=[dict(r) for r in c.execute('SELECT p.id,p.name,p.group_name,p.last_seen,CASE WHEN p.last_seen>? THEN 1 ELSE 0 END online,COALESCE(SUM(s.points),0) score FROM participants p LEFT JOIN scores s ON s.participant_id=p.id WHERE p.game_id=? GROUP BY p.id ORDER BY score DESC,p.name',(time.time()-35,gid))]
        for person in people: person['round_score']=round_points.get(int(person['id']),0)
        if game and game['format']=='team':
            grouped={}
            for person in people:
                key=person['group_name'].strip() or f"__solo_{person['id']}"
                if key not in grouped: grouped[key]={'id':person['id'],'name':person['group_name'].strip() or person['name'],'group_name':person['group_name'].strip() or 'Участник без команды','score':0,'round_score':0}
                grouped[key]['score']+=person['score']
                grouped[key]['round_score']+=person['round_score']
            scoreboard=sorted(grouped.values(),key=lambda x:(-x['score'],x['name']))
        else: scoreboard=people
        summary=None
        if active_round and settings.get('screen_mode')=='round_summary':
            summary_board=[dict(x) for x in scoreboard]
            summary_board.sort(key=lambda x:(-int(x.get('round_score',0)),-int(x.get('score',0)),x['name']))
            summary={
                'round_id':active_round_id,
                'title':active_round['title'],
                'scoreboard':summary_board,
                'participants_count':len(people),
                'round_points_total':sum(int(x.get('round_score',0)) for x in summary_board)
            }
        reaction_events=[dict(x) for x in c.execute('SELECT r.id,r.emoji,p.name FROM reactions r JOIN participants p ON p.id=r.participant_id WHERE r.game_id=? AND r.created_at>? ORDER BY r.id',(gid,time.time()-12))]
        reaction_counts=[dict(x) for x in c.execute('SELECT emoji,COUNT(*) count FROM reactions WHERE game_id=? GROUP BY emoji ORDER BY count DESC',(gid,))]
        return {
            'game':dict(game) if game else None,'rounds':rounds,'participants':people,'scoreboard':scoreboard,
            'current_question':current_q,'active_round':active_round,'active_round_id':active_round_id,
            'screen_mode':settings.get('screen_mode','welcome'),
            'allow_answers':current_q['allow_answers_effective'] if current_q else (active_round['allow_answers_effective'] if active_round else (bool(game['allow_answers']) if game else False)),
            'format':game['format'] if game else 'team','status':game['status'] if game else 'draft',
            'answers_revealed':revealed,'answer_stats':answer_stats if revealed else [],'answer_count':answer_count if revealed else 0,
            'timer_remaining':remaining,'public_url':settings.get('public_url',''),'reaction_events':reaction_events,
            'reaction_counts':reaction_counts,'round_summary':summary,
            'media_control':media_control,'screen_media':screen_media,'server_time':time.time()
        }

async def broadcast():
    payload=json.dumps(state(),ensure_ascii=False); dead=[]
    for ws in list(clients):
        try: await ws.send_text(payload)
        except: dead.append(ws)
    for ws in dead: clients.discard(ws)
    admin_payload=json.dumps(state(include_private=True),ensure_ascii=False); dead=[]
    for ws in list(admin_clients):
        try: await ws.send_text(admin_payload)
        except: dead.append(ws)
    for ws in dead: admin_clients.discard(ws)

@app.get('/',include_in_schema=False)
async def home(): return RedirectResponse('/admin')
@app.get('/admin')
async def admin_page(): return FileResponse(STATIC/'admin.html')
@app.get('/display')
async def display_page(): return FileResponse(STATIC/'display.html')
@app.get('/join')
async def join_page(): return FileResponse(STATIC/'join.html')
@app.get('/api/state')
async def get_state(): return state()
@app.get('/api/admin/state')
async def get_admin_state(x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key); return state(include_private=True)
@app.post('/api/login')
async def login(p:Login):
    if not secrets.compare_digest(p.password,ADMIN_KEY): raise HTTPException(401,'Неверный пароль')
    return {'ok':True,'token':ADMIN_KEY}
@app.websocket('/ws')
async def websocket(ws:WebSocket):
    await ws.accept(); clients.add(ws); await ws.send_text(json.dumps(state(),ensure_ascii=False))
    try:
        while True:
            try: await asyncio.wait_for(ws.receive_text(),timeout=1.0)
            except asyncio.TimeoutError: await ws.send_text(json.dumps(state(),ensure_ascii=False))
    except WebSocketDisconnect: clients.discard(ws)

@app.websocket('/ws/admin')
async def admin_websocket(ws:WebSocket):
    key=ws.query_params.get('key','')
    if not key or not secrets.compare_digest(key,ADMIN_KEY):
        await ws.close(code=4401); return
    await ws.accept(); admin_clients.add(ws); await ws.send_text(json.dumps(state(include_private=True),ensure_ascii=False))
    try:
        while True:
            try: await asyncio.wait_for(ws.receive_text(),timeout=1.0)
            except asyncio.TimeoutError: await ws.send_text(json.dumps(state(include_private=True),ensure_ascii=False))
    except WebSocketDisconnect: admin_clients.discard(ws)

@app.get('/api/admin/games')
async def list_games(x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key)
    with db() as c: return [dict(r) for r in c.execute('SELECT * FROM games ORDER BY id DESC')]

@app.post('/api/admin/action')
async def action(p:Payload,x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key); d=p.data; a=p.action
    with db() as c:
        gid=current_game_id(c)
        if a=='create_game':
            clear_screen_media(c)
            stop_media_control(c)
            cur=c.execute('INSERT INTO games(title,format,allow_answers,status,game_type,description,show_scoreboard,allow_registration) VALUES(?,?,?,?,?,?,?,?)',(d.get('title') or 'Новая игра',d.get('format','team'),int(bool(d.get('allow_answers'))),'draft',d.get('game_type','mixed'),d.get('description',''),int(d.get('show_scoreboard',1)),int(d.get('allow_registration',1))))
            gid=cur.lastrowid; c.execute('INSERT INTO rounds(game_id,title,position) VALUES(?,?,1)',(gid,'Раунд 1'))
            c.execute("UPDATE settings SET value=? WHERE key='current_game'",(str(gid),)); c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'"); c.execute("UPDATE settings SET value='welcome' WHERE key='screen_mode'"); c.execute("UPDATE settings SET value='0' WHERE key='active_round_id'")
        elif a=='select_game':
            clear_screen_media(c)
            stop_media_control(c)
            running=c.execute("SELECT round_id FROM round_progress WHERE game_id=? AND status='in_progress' LIMIT 1",(gid,)).fetchone()
            if running: raise HTTPException(409,'Нельзя переключить игру во время активного раунда. Сначала подведите его итоги.')
            target=int(d['game_id'])
            if not c.execute('SELECT id FROM games WHERE id=?',(target,)).fetchone(): raise HTTPException(404,'Игра не найдена')
            gid=target; c.execute("UPDATE settings SET value=? WHERE key='current_game'",(str(gid),)); c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'"); c.execute("UPDATE settings SET value='welcome' WHERE key='screen_mode'"); c.execute("UPDATE settings SET value='0' WHERE key='active_round_id'")
        elif a=='update_game':
            c.execute('UPDATE games SET title=?,format=?,allow_answers=?,game_type=?,description=?,show_scoreboard=?,allow_registration=? WHERE id=?',(d['title'],d.get('format','team'),int(bool(d.get('allow_answers'))),d.get('game_type','mixed'),d.get('description',''),int(d.get('show_scoreboard',1)),int(d.get('allow_registration',1)),int(d['game_id'])))
        elif a=='add_round':
            pos=c.execute('SELECT COALESCE(MAX(position),0)+1 p FROM rounds WHERE game_id=?',(gid,)).fetchone()['p']
            c.execute('INSERT INTO rounds(game_id,title,position,allow_answers,round_type,instructions) VALUES(?,?,?,?,?,?)',(gid,d.get('title') or f'Раунд {pos}',pos,int(d.get('allow_answers',-1)),d.get('round_type','standard'),d.get('instructions','')))
        elif a=='update_round':
            c.execute('UPDATE rounds SET title=?,allow_answers=?,round_type=?,instructions=? WHERE id=?',(d['title'],int(d.get('allow_answers',-1)),d.get('round_type','standard'),d.get('instructions',''),int(d['round_id'])))
        elif a=='move_round':
            rid=int(d['round_id']); direction=int(d.get('direction',0)); row=c.execute('SELECT id,game_id,position FROM rounds WHERE id=?',(rid,)).fetchone()
            if row:
                other=c.execute('SELECT id,position FROM rounds WHERE game_id=? AND position '+('<' if direction<0 else '>')+' ? ORDER BY position '+('DESC' if direction<0 else 'ASC')+' LIMIT 1',(row['game_id'],row['position'])).fetchone()
                if other: c.execute('UPDATE rounds SET position=? WHERE id=?',(other['position'],rid)); c.execute('UPDATE rounds SET position=? WHERE id=?',(row['position'],other['id']))
        elif a=='move_question':
            qid=int(d['question_id']); direction=int(d.get('direction',0)); row=c.execute('SELECT id,round_id,position FROM questions WHERE id=?',(qid,)).fetchone()
            if row:
                other=c.execute('SELECT id,position FROM questions WHERE round_id=? AND position '+('<' if direction<0 else '>')+' ? ORDER BY position '+('DESC' if direction<0 else 'ASC')+' LIMIT 1',(row['round_id'],row['position'])).fetchone()
                if other: c.execute('UPDATE questions SET position=? WHERE id=?',(other['position'],qid)); c.execute('UPDATE questions SET position=? WHERE id=?',(row['position'],other['id']))
        elif a=='delete_round':
            rid=int(d['round_id']); c.execute('DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE round_id=?)',(rid,)); c.execute('DELETE FROM scores WHERE round_id=?',(rid,)); c.execute('DELETE FROM round_progress WHERE game_id=? AND round_id=?',(gid,rid)); c.execute('DELETE FROM questions WHERE round_id=?',(rid,)); c.execute('DELETE FROM rounds WHERE id=?',(rid,))
            if int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)==rid:
                clear_screen_media(c)
                stop_media_control(c)
                c.execute("UPDATE settings SET value='0' WHERE key='active_round_id'"); c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='welcome' WHERE key='screen_mode'")
        elif a=='add_question':
            rid=int(d['round_id']); pos=c.execute('SELECT COALESCE(MAX(position),0)+1 p FROM questions WHERE round_id=?',(rid,)).fetchone()['p']
            c.execute('INSERT INTO questions(round_id,title,body,points,media,media_type,position,question_type,options_json,correct_answer,explanation,time_limit,required) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(rid,d.get('title',''),d.get('body',''),int(d.get('points',1)),d.get('media',''),d.get('media_type',''),pos,d.get('question_type','text'),json.dumps(d.get('options',[]),ensure_ascii=False),d.get('correct_answer',''),d.get('explanation',''),int(d.get('time_limit',0)),int(bool(d.get('required',0)))))
        elif a=='update_question':
            c.execute('UPDATE questions SET title=?,body=?,points=?,media=?,media_type=?,question_type=?,options_json=?,correct_answer=?,explanation=?,time_limit=?,required=? WHERE id=?',(d.get('title',''),d.get('body',''),int(d.get('points',1)),d.get('media',''),d.get('media_type',''),d.get('question_type','text'),json.dumps(d.get('options',[]),ensure_ascii=False),d.get('correct_answer',''),d.get('explanation',''),int(d.get('time_limit',0)),int(bool(d.get('required',0))),int(d['question_id'])))
        elif a=='delete_question':
            qid=int(d['question_id']); c.execute('DELETE FROM answers WHERE question_id=?',(qid,)); c.execute('DELETE FROM scores WHERE question_id=?',(qid,)); c.execute('DELETE FROM questions WHERE id=?',(qid,))
        elif a=='reset_round':
            rid=int(d.get('round_id') or 0)
            round_row=c.execute('SELECT id FROM rounds WHERE id=? AND game_id=?',(rid,gid)).fetchone()
            if not round_row: raise HTTPException(404,'Раунд не найден в текущей игре')
            c.execute('DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE round_id=?)',(rid,))
            c.execute('DELETE FROM scores WHERE round_id=? OR question_id IN (SELECT id FROM questions WHERE round_id=?)',(rid,rid))
            c.execute('DELETE FROM round_progress WHERE game_id=? AND round_id=?',(gid,rid))
            active_id=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
            if active_id==rid:
                clear_screen_media(c)
                stop_media_control(c)
                c.execute("UPDATE settings SET value='0' WHERE key='active_round_id'")
                c.execute("UPDATE settings SET value='0' WHERE key='current_question'")
                c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'")
                c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'")
                c.execute("UPDATE settings SET value='' WHERE key='timer_frozen_remaining'")
                c.execute("UPDATE settings SET value='welcome' WHERE key='screen_mode'")
        elif a=='reset_quiz':
            clear_screen_media(c)
            stop_media_control(c)
            c.execute('DELETE FROM answers WHERE participant_id IN (SELECT id FROM participants WHERE game_id=?) OR question_id IN (SELECT q.id FROM questions q JOIN rounds r ON r.id=q.round_id WHERE r.game_id=?)',(gid,gid))
            c.execute('DELETE FROM scores WHERE participant_id IN (SELECT id FROM participants WHERE game_id=?)',(gid,))
            c.execute('DELETE FROM reactions WHERE game_id=?',(gid,))
            c.execute('DELETE FROM participants WHERE game_id=?',(gid,))
            c.execute('DELETE FROM round_progress WHERE game_id=?',(gid,))
            c.execute("UPDATE settings SET value='0' WHERE key='active_round_id'")
            c.execute("UPDATE settings SET value='0' WHERE key='current_question'")
            c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'")
            c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'")
            c.execute("UPDATE settings SET value='' WHERE key='timer_frozen_remaining'")
            c.execute("UPDATE settings SET value='welcome' WHERE key='screen_mode'")
            c.execute("UPDATE games SET status='draft' WHERE id=?",(gid,))
        elif a=='start_round':
            clear_screen_media(c)
            rid=int(d.get('round_id') or 0)
            round_row=c.execute('SELECT * FROM rounds WHERE id=? AND game_id=?',(rid,gid)).fetchone()
            if not round_row: raise HTTPException(404,'Раунд не найден в текущей игре')
            first=c.execute('SELECT id FROM questions WHERE round_id=? ORDER BY position,id LIMIT 1',(rid,)).fetchone()
            if not first: raise HTTPException(400,'В этом раунде пока нет вопросов')
            progress=c.execute('SELECT status FROM round_progress WHERE game_id=? AND round_id=?',(gid,rid)).fetchone()
            progress_status=progress['status'] if progress else 'pending'
            active_id=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
            if progress_status=='completed': raise HTTPException(409,'Этот раунд уже завершён. Для повторной игры создайте его копию.')
            if progress_status=='in_progress':
                if active_id!=rid: raise HTTPException(409,'Сначала завершите текущий активный раунд.')
                current=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
                current_valid=c.execute('SELECT id FROM questions WHERE id=? AND round_id=?',(current,rid)).fetchone()
                if not current_valid: raise HTTPException(409,'Не удалось восстановить текущий вопрос этого раунда.')
                c.execute("UPDATE settings SET value='question' WHERE key='screen_mode'")
            else:
                stop_media_control(c)
                other=c.execute("SELECT round_id FROM round_progress WHERE game_id=? AND status='in_progress' LIMIT 1",(gid,)).fetchone()
                if other: raise HTTPException(409,'Сначала завершите текущий раунд через блок управления на вкладке «Обзор».')
                now=time.time()
                c.execute('INSERT INTO round_progress(game_id,round_id,status,started_at,finished_at) VALUES(?,?,?,?,NULL) ON CONFLICT(game_id,round_id) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,finished_at=NULL',(gid,rid,'in_progress',now))
                c.execute("UPDATE settings SET value=? WHERE key='active_round_id'",(str(rid),))
                c.execute("UPDATE settings SET value=? WHERE key='current_question'",(str(first['id']),))
                c.execute("UPDATE settings SET value='question' WHERE key='screen_mode'")
                c.execute("UPDATE settings SET value=? WHERE key='question_started_at'",(str(now),))
                c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'")
                c.execute("UPDATE settings SET value='' WHERE key='timer_frozen_remaining'")
            c.execute("UPDATE games SET status='active' WHERE id=?",(gid,))
        elif a=='set_question':
            clear_screen_media(c)
            stop_media_control(c)
            qid=int(d.get('question_id',0))
            valid=c.execute('SELECT q.id,q.round_id FROM questions q JOIN rounds r ON q.round_id=r.id WHERE q.id=? AND r.game_id=?',(qid,gid)).fetchone()
            if not valid: raise HTTPException(404,'Вопрос не найден в текущей игре')
            rid=int(valid['round_id'])
            progress=c.execute('SELECT status FROM round_progress WHERE game_id=? AND round_id=?',(gid,rid)).fetchone()
            if progress and progress['status']=='completed': raise HTTPException(409,'Раунд уже завершён. Запускать вопросы повторно нельзя.')
            active_id=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
            other=c.execute("SELECT round_id FROM round_progress WHERE game_id=? AND status='in_progress' LIMIT 1",(gid,)).fetchone()
            if other and int(other['round_id'])!=rid: raise HTTPException(409,'Сначала завершите текущий раунд.')
            c.execute("INSERT INTO round_progress(game_id,round_id,status,started_at,finished_at) VALUES(?,?,?,?,NULL) ON CONFLICT(game_id,round_id) DO UPDATE SET status=CASE WHEN status='pending' THEN 'in_progress' ELSE status END,started_at=COALESCE(started_at,excluded.started_at)",(gid,rid,'in_progress',time.time()))
            c.execute("UPDATE settings SET value=? WHERE key='active_round_id'",(str(rid),))
            c.execute("UPDATE games SET status='active' WHERE id=?",(gid,))
            c.execute("UPDATE settings SET value=? WHERE key='current_question'",(str(qid),)); c.execute("UPDATE settings SET value='question' WHERE key='screen_mode'"); c.execute("UPDATE settings SET value=? WHERE key='question_started_at'",(str(time.time()),)); c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='' WHERE key='timer_frozen_remaining'")
        elif a=='next_question':
            clear_screen_media(c)
            rid=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
            qid=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
            if not rid or not qid: raise HTTPException(400,'Сейчас нет активного вопроса раунда')
            revealed=c.execute("SELECT value FROM settings WHERE key='answers_revealed'").fetchone()['value']=='1'
            if not revealed: raise HTTPException(400,'Сначала откройте ответы — дождитесь таймера или нажмите «Открыть ответы».')
            current=c.execute('SELECT round_id,position FROM questions WHERE id=?',(qid,)).fetchone()
            if not current or int(current['round_id'])!=rid: raise HTTPException(409,'Текущий вопрос не относится к активному раунду')
            nxt=c.execute('SELECT id FROM questions WHERE round_id=? AND (position>? OR (position=? AND id>?)) ORDER BY position,id LIMIT 1',(rid,current['position'],current['position'],qid)).fetchone()
            if nxt:
                stop_media_control(c)
                now=time.time(); c.execute("UPDATE settings SET value=? WHERE key='current_question'",(str(nxt['id']),)); c.execute("UPDATE settings SET value=? WHERE key='question_started_at'",(str(now),)); c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='' WHERE key='timer_frozen_remaining'"); c.execute("UPDATE settings SET value='question' WHERE key='screen_mode'")
            else:
                stop_media_control(c)
                c.execute("UPDATE round_progress SET status='completed',finished_at=? WHERE game_id=? AND round_id=?",(time.time(),gid,rid))
                c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'"); c.execute("UPDATE settings SET value='1' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='0' WHERE key='timer_frozen_remaining'"); c.execute("UPDATE settings SET value='round_summary' WHERE key='screen_mode'")
        elif a=='finish_round':
            clear_screen_media(c)
            stop_media_control(c)
            rid=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
            if not rid: raise HTTPException(400,'Нет активного раунда')
            progress=c.execute('SELECT status FROM round_progress WHERE game_id=? AND round_id=?',(gid,rid)).fetchone()
            if not progress or progress['status']!='in_progress': raise HTTPException(409,'Активный раунд не найден')
            qid=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
            if qid:
                finalize_question(c,qid)
            c.execute("UPDATE round_progress SET status='completed',finished_at=? WHERE game_id=? AND round_id=?",(time.time(),gid,rid))
            c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'"); c.execute("UPDATE settings SET value='1' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='0' WHERE key='timer_frozen_remaining'"); c.execute("UPDATE settings SET value='round_summary' WHERE key='screen_mode'")
        elif a=='reveal_answers':
            qid=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
            if qid:
                freeze_question_timer(c,qid)
                finalize_question(c,qid)
            c.execute("UPDATE settings SET value='1' WHERE key='answers_revealed'")
        elif a=='set_public_url': c.execute("UPDATE settings SET value=? WHERE key='public_url'",(str(d.get('url','')).strip().rstrip('/').removesuffix('/join').removesuffix('/admin'),))
        elif a=='set_screen':
            if d['mode']!='question': stop_media_control(c)
            clear_screen_media(c)
            c.execute("UPDATE settings SET value=? WHERE key='screen_mode'",(d['mode'],))
        elif a=='show_screen_media':
            show_screen_media(c,d)
        elif a=='hide_screen_media':
            hide_screen_media(c)
        elif a in ('media_play','media_pause','media_restart','media_stop'):
            set_media_control(c,a)
        elif a=='start_game':
            clear_screen_media(c)
            running=c.execute("SELECT round_id FROM round_progress WHERE game_id=? AND status='in_progress' LIMIT 1",(gid,)).fetchone()
            c.execute("UPDATE games SET status='active' WHERE id=?",(gid,))
            if running:
                c.execute("UPDATE settings SET value=? WHERE key='active_round_id'",(str(running['round_id']),))
                c.execute("UPDATE settings SET value='question' WHERE key='screen_mode'")
            else:
                stop_media_control(c)
                c.execute("UPDATE settings SET value='welcome' WHERE key='screen_mode'"); c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='0' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'"); c.execute("UPDATE settings SET value='0' WHERE key='active_round_id'")
        elif a=='set_status':
            new_status=str(d['status']); target_game=int(d.get('game_id') or gid)
            c.execute('UPDATE games SET status=? WHERE id=?',(new_status,target_game))
            if new_status=='finished' and target_game==gid:
                clear_screen_media(c)
                stop_media_control(c)
                active_id=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
                if active_id:
                    qid=int(c.execute("SELECT value FROM settings WHERE key='current_question'").fetchone()['value'] or 0)
                    if qid: finalize_question(c,qid)
                    c.execute("UPDATE round_progress SET status='completed',finished_at=? WHERE game_id=? AND round_id=? AND status='in_progress'",(time.time(),gid,active_id))
                c.execute("UPDATE settings SET value='0' WHERE key='current_question'"); c.execute("UPDATE settings SET value='0' WHERE key='question_started_at'"); c.execute("UPDATE settings SET value='1' WHERE key='answers_revealed'"); c.execute("UPDATE settings SET value='0' WHERE key='timer_frozen_remaining'"); c.execute("UPDATE settings SET value='scoreboard' WHERE key='screen_mode'")
        elif a=='add_participant':
            c.execute('INSERT INTO participants(name,group_name,game_id,last_seen) VALUES(?,?,?,?)',(d['name'],'',gid,time.time()))
        elif a=='assign_group':
            c.execute('UPDATE participants SET group_name=? WHERE id=? AND game_id=?',(str(d.get('group_name','')).strip()[:60],int(d['participant_id']),gid))
        elif a=='delete_participant':
            pid=int(d['participant_id']); c.execute('DELETE FROM answers WHERE participant_id=?',(pid,)); c.execute('DELETE FROM scores WHERE participant_id=?',(pid,)); c.execute('DELETE FROM participants WHERE id=?',(pid,))
        elif a=='score':
            active_id=int(c.execute("SELECT value FROM settings WHERE key='active_round_id'").fetchone()['value'] or 0)
            active_progress=c.execute('SELECT status FROM round_progress WHERE game_id=? AND round_id=?',(gid,active_id)).fetchone() if active_id else None
            round_id=active_id if active_progress and active_progress['status']=='in_progress' else None
            c.execute('INSERT INTO scores(participant_id,points,reason,round_id) VALUES(?,?,?,?)',(int(d['participant_id']),int(d['points']),d.get('reason','Ручное начисление'),round_id))
        elif a=='undo_score':
            row=c.execute('SELECT id FROM scores WHERE participant_id IN (SELECT id FROM participants WHERE game_id=?) ORDER BY id DESC LIMIT 1',(gid,)).fetchone()
            if row: c.execute('DELETE FROM scores WHERE id=?',(row['id'],))
        elif a=='clear_scores': c.execute('DELETE FROM scores WHERE participant_id IN (SELECT id FROM participants WHERE game_id=?)',(gid,))
        else: raise HTTPException(400,'Неизвестное действие')
    await broadcast(); return {'ok':True,'state':state()}

@app.get('/api/admin/media')
async def admin_media(x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key)
    items=[]
    with db() as c:
        refs={r['media']:[] for r in c.execute("SELECT DISTINCT media FROM questions WHERE media!=''")}
        for r in c.execute("SELECT q.id,q.title,ro.title round_title,q.media FROM questions q JOIN rounds ro ON ro.id=q.round_id WHERE q.media!=''"):
            refs.setdefault(r['media'],[]).append({'question_id':r['id'],'title':r['title'] or 'Без названия','round_title':r['round_title']})
    for path in sorted(MEDIA.iterdir()):
        if not path.is_file() or path.name.startswith('.'): continue
        ext=path.suffix.lower()
        typ='audio' if ext in {'.mp3','.wav','.ogg','.m4a','.aac','.flac'} else 'video' if ext in {'.mp4','.webm','.mov','.m4v'} else 'image'
        url='/media/'+path.name
        items.append({'name':path.name,'url':url,'type':typ,'size':path.stat().st_size,'references':refs.get(url,[])})
    return items

@app.delete('/api/admin/media/{name}')
async def delete_admin_media(name:str,x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key)
    if Path(name).name!=name or name in ('','.','..'): raise HTTPException(400,'Некорректное имя файла')
    target=MEDIA/name
    if not target.is_file(): raise HTTPException(404,'Файл не найден')
    url='/media/'+name
    with db() as c:
        active=get_screen_media(c)
        if active and active.get('url')==url: raise HTTPException(409,'Сначала скройте файл с главного экрана')
        used=c.execute('SELECT COUNT(*) n FROM questions WHERE media=?',(url,)).fetchone()['n']
        if used: raise HTTPException(409,'Сначала открепите файл от всех вопросов')
        target.unlink()
    return {'ok':True}

@app.post('/api/upload')
async def upload(file:UploadFile=File(...),x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key)
    suffix=Path(file.filename or 'file').suffix.lower()
    allowed={'.mp3','.wav','.ogg','.m4a','.aac','.flac','.mp4','.webm','.mov','.m4v','.jpg','.jpeg','.png','.gif','.webp'}
    if suffix not in allowed: raise HTTPException(400,'Формат файла не поддерживается')
    max_bytes=500*1024*1024; name=secrets.token_hex(12)+suffix; dest=MEDIA/name; size=0
    try:
        with dest.open('wb') as out:
            while chunk:=await file.read(1024*1024):
                size+=len(chunk)
                if size>max_bytes: raise HTTPException(413,'Файл больше 500 МБ')
                out.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True); raise
    typ='audio' if suffix in {'.mp3','.wav','.ogg','.m4a','.aac','.flac'} else 'video' if suffix in {'.mp4','.webm','.mov','.m4v'} else 'image'
    return {'url':'/media/'+name,'type':typ,'filename':file.filename,'size':size}

@app.post('/api/register')
async def register(p:dict):
    s=state(); g=s['game']
    if not g or not g.get('allow_registration',1): raise HTTPException(403,'Регистрация участников закрыта')
    name=(p.get('name') or '').strip()[:60]
    if not name: raise HTTPException(400,'Укажите имя')
    with db() as c:
        cur=c.execute('INSERT INTO participants(name,group_name,game_id,last_seen) VALUES(?,?,?,?)',(name,'',int(g['id']),time.time()))
        pid=cur.lastrowid
    await broadcast(); return {'ok':True,'participant_id':pid}
@app.post('/api/answer')
async def answer(p:Answer):
    s=state(); q=s.get('current_question')
    if not q or not q.get('allow_answers_effective'): raise HTTPException(403,'Ответы с телефона отключены для этого раунда')
    with db() as c:
        st={r['key']:r['value'] for r in c.execute("SELECT * FROM settings WHERE key IN ('question_started_at','answers_revealed')")}
    if st.get('answers_revealed')=='1': raise HTTPException(403,'Время ответов завершено')
    limit=int(q.get('time_limit') or 0); started=float(st.get('question_started_at','0') or 0)
    if limit and started and time.time()-started>=limit:
        with db() as c: c.execute("UPDATE settings SET value='1' WHERE key='answers_revealed'")
        await broadcast(); raise HTTPException(403,'Время ответа истекло')
    if q['question_type'] in ('single_choice','multiple_choice','true_false'):
        allowed=[str(x) for x in q.get('options',[])]
        if q['question_type']=='multiple_choice':
            selected=[x.strip() for x in p.text.split(',') if x.strip()]
            if not selected or any(x not in allowed for x in selected): raise HTTPException(400,'Выберите варианты из списка')
        elif p.text not in allowed:
            raise HTTPException(400,'Выберите вариант из списка')
    with db() as c:
        person=c.execute('SELECT id FROM participants WHERE id=? AND game_id=?',(p.participant_id,int(s['game']['id']))).fetchone()
        if not person: raise HTTPException(403,'Участник не зарегистрирован в этой игре')
        c.execute('UPDATE participants SET last_seen=? WHERE id=?',(time.time(),p.participant_id))
        existing=c.execute('SELECT id,is_correct FROM answers WHERE participant_id=? AND question_id=? ORDER BY id DESC LIMIT 1',(p.participant_id,q['id'])).fetchone()
        if existing and existing['is_correct'] is not None: raise HTTPException(409,'Вы уже отвечали на этот вопрос. Повторная попытка не предусмотрена.')
        if existing: c.execute('UPDATE answers SET text=?,created_at=CURRENT_TIMESTAMP,is_correct=NULL,awarded_points=0 WHERE id=?',(p.text[:500],existing['id']))
        else: c.execute('INSERT INTO answers(participant_id,question_id,text) VALUES(?,?,?)',(p.participant_id,q['id'],p.text[:500]))
    await broadcast(); return {'ok':True}
@app.get('/api/player/question-result')
async def player_question_result(participant_id:int, question_id:int):
    s=state()
    if not s.get('game') or not any(int(p['id'])==participant_id for p in s.get('participants',[])):
        raise HTTPException(403,'Участник не зарегистрирован в этой игре')
    if not s.get('answers_revealed') or not s.get('current_question') or int(s['current_question']['id'])!=question_id:
        raise HTTPException(409,'Результат вопроса ещё не открыт')
    with db() as c:
        row=c.execute('SELECT text,is_correct,awarded_points FROM answers WHERE participant_id=? AND question_id=? ORDER BY id DESC LIMIT 1',(participant_id,question_id)).fetchone()
        q=c.execute('SELECT correct_answer,explanation FROM questions WHERE id=?',(question_id,)).fetchone()
    if not row:
        return {'answered':False,'is_correct':False,'answer':'','awarded_points':0,'correct_answer':q['correct_answer'] if q else '', 'explanation':q['explanation'] if q else ''}
    return {'answered':True,'is_correct':bool(row['is_correct']),'answer':row['text'],'awarded_points':int(row['awarded_points'] or 0),'correct_answer':q['correct_answer'] if q else '', 'explanation':q['explanation'] if q else ''}

@app.post('/api/presence')
async def presence(p:dict):
    pid=int(p.get('participant_id') or 0)
    with db() as c:
        gid=current_game_id(c)
        cur=c.execute('UPDATE participants SET last_seen=? WHERE id=? AND game_id=?',(time.time(),pid,gid))
        if not cur.rowcount: raise HTTPException(404,'Участник больше не зарегистрирован в текущей игре')
    return {'ok':True}

@app.post('/api/reaction')
async def reaction(p:dict):
    pid=int(p.get('participant_id') or 0); emoji=str(p.get('emoji') or '')
    allowed={'👍','❤️','😂','🔥','👏','😮','🎉','🤔'}
    if emoji not in allowed: raise HTTPException(400,'Недопустимая реакция')
    s=state(); gid=int(s['game']['id']) if s.get('game') else 0
    with db() as c:
        person=c.execute('SELECT id FROM participants WHERE id=? AND game_id=?',(pid,gid)).fetchone()
        if not person: raise HTTPException(403,'Сначала подключитесь к игре')
        last=c.execute('SELECT created_at FROM reactions WHERE participant_id=? ORDER BY id DESC LIMIT 1',(pid,)).fetchone()
        now=time.time()
        if last and now-float(last['created_at'])<0.65: raise HTTPException(429,'Подождите немного перед следующей реакцией')
        c.execute('INSERT INTO reactions(participant_id,game_id,emoji,created_at) VALUES(?,?,?,?)',(pid,gid,emoji,now))
        c.execute('UPDATE participants SET last_seen=? WHERE id=?',(now,pid))
    await broadcast(); return {'ok':True}

@app.get('/api/admin/answers')
async def answers(x_admin_key:str|None=Header(default=None)):
    admin(x_admin_key)
    with db() as c:
        gid=current_game_id(c)
        return [dict(r) for r in c.execute('SELECT a.*,p.name,p.group_name,q.title question_title FROM answers a JOIN participants p ON p.id=a.participant_id LEFT JOIN questions q ON q.id=a.question_id WHERE p.game_id=? AND a.id=(SELECT MAX(b.id) FROM answers b WHERE b.question_id=a.question_id AND b.participant_id=a.participant_id) ORDER BY a.id DESC LIMIT 300',(gid,))]


@app.get('/api/connect-qr')
async def connect_qr(request: Request):
    with db() as c:
        row=c.execute("SELECT value FROM settings WHERE key='public_url'").fetchone()
    base=(row['value'] if row and row['value'] else str(request.base_url).rstrip('/')).rstrip('/')
    parsed=urlsplit(base)
    if not (row and row['value']) and parsed.hostname in ('127.0.0.1','localhost','0.0.0.0','::1'):
        try:
            probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); probe.connect(('8.8.8.8',80)); lan_ip=probe.getsockname()[0]; probe.close()
        except OSError: lan_ip='127.0.0.1'
        base=f"http://{lan_ip}:{parsed.port or 8080}"
    target=base+'/join'
    img=qrcode.make(target)
    out=io.BytesIO(); img.save(out,format='PNG')
    return Response(content=out.getvalue(),media_type='image/png',headers={'Cache-Control':'no-store','X-Join-Url':target})

@app.on_event('startup')
async def startup():
    print('\n'+'='*58+'\n QUIZCONTROL 0.6.4\n Админка: http://127.0.0.1:8080/admin\n Экран: http://127.0.0.1:8080/display\n Участники: http://127.0.0.1:8080/join\n Пароль организатора: '+ADMIN_KEY+'\n'+'='*58+'\n')
