const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g,' ');
const gameNames={classic:'КЛАССИЧЕСКИЙ КВИЗ',music:'УГАДАЙ МЕЛОДИЮ',video:'ВИДЕО-КВИЗ',mixed:'СМЕШАННАЯ ИГРА',custom:'СВОЙ СЦЕНАРИЙ'};
const medals=['🥇','🥈','🥉'];
function mediaHtml(q){
  if(!q.media)return '';
  const src=esc(q.media);
  if(q.media_type==='audio')return `<div class="stage-media-audio"><div class="audio-icon">♫</div><div class="media-track-label">АУДИОТРЕК · УПРАВЛЯЕТ ВЕДУЩИЙ</div><div id="stageMediaMount" class="stage-media-mount"></div><div id="stageMediaStatus" class="media-sync-status"></div><div id="stageMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить звук</button></div></div>`;
  if(q.media_type==='video')return `<div class="stage-media-video-wrap"><div id="stageMediaMount" class="stage-media-mount"></div><div id="stageMediaStatus" class="media-sync-status"></div><div id="stageMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить видео и звук</button></div></div>`;
  if(q.media_type==='image')return `<img class="stage-image" src="${src}" alt="Иллюстрация к вопросу">`;
  return '';
}
function correctValues(q){return new Set(String(q.correct_answer||'').split(',').map(normalize).filter(Boolean));}
function statsHtml(s){
  if(!s.answers_revealed)return '';
  const q=s.current_question||{},stats=s.answer_stats||[],correctSet=correctValues(q);
  return `<section class="reveal-panel"><div class="reveal-head"><div><div class="orange-kicker">ОТВЕТЫ УЧАСТНИКОВ</div><h2>Как отвечали игроки</h2></div><div class="answer-total">${s.answer_count||0}<small>ответов</small></div></div>${stats.length?stats.map(a=>`<div class="poll-row ${correctSet.has(normalize(a.text))?'correct':''}"><div class="poll-label"><span>${esc(a.text)}</span><b>${a.percent}%</b></div><div class="poll-track"><i style="width:${a.percent}%"></i></div></div>`).join(''):'<p class="stage-muted">Ответов пока нет</p>'}<div class="correct-answer"><span>ПРАВИЛЬНЫЙ ОТВЕТ</span><strong>${esc(q.correct_answer||'Не указан организатором')}</strong></div>${q.explanation?`<p class="explanation">${esc(q.explanation)}</p>`:''}</section>`;
}
function optionHtml(q,s){
  const options=q.options||[],correct=correctValues(q);
  return options.map((o,i)=>{
    const isCorrect=!!s.answers_revealed&&correct.has(normalize(o));
    return `<div class="stage-option ${isCorrect?'correct-option':''}"><span>${String.fromCharCode(65+i)}</span><b>${esc(o)}</b>${isCorrect?'<em class="correct-option-label">✓ ПРАВИЛЬНО</em>':''}</div>`;
  }).join('');
}
function rankRow(p,i,{round=false}={}){
  const podium=i<3?` podium podium-${i+1}`:'';
  const place=i<3?medals[i]:String(i+1).padStart(2,'0');
  if(round)return `<div class="stage-rank${podium}"><span class="place">${place}</span><div class="rank-name">${esc(p.name)}<small>${esc(p.group_name||'')}</small></div><div class="round-score-value">+${p.round_score||0}<small>ЗА РАУНД</small></div><div class="total-score-value">${p.score||0}<small>ВСЕГО</small></div></div>`;
  return `<div class="stage-rank${podium}"><span class="place">${place}</span><div class="rank-name">${esc(p.name)}<small>${esc(p.group_name||'')}</small></div><b>${p.score||0}<small>баллов</small></b></div>`;
}
let seenReactionId=0;
function renderReactions(s){
  const layer=document.getElementById('reactionLayer');
  if(!layer)return;
  for(const r of (s.reaction_events||[])){
    if(r.id<=seenReactionId)continue;
    seenReactionId=Math.max(seenReactionId,r.id);
    const el=document.createElement('div');el.className='reaction-float';el.style.left=(8+Math.random()*82)+'%';
    el.innerHTML=`${esc(r.emoji)}<span>${esc(r.name)}</span>`;layer.appendChild(el);setTimeout(()=>el.remove(),3600);
  }
}
function renderReactionCounter(s){
  const el=document.getElementById('reactionCounter');if(!el)return;
  const counts=s.reaction_counts||[],total=counts.reduce((n,x)=>n+Number(x.count||0),0);
  el.innerHTML=`<div class="reaction-counter-title">РЕАКЦИИ · ${total}</div><div class="reaction-counter-items">${counts.map(x=>`<span>${esc(x.emoji)} <b>${x.count}</b></span>`).join('')||'<span class="reaction-counter-empty">Пока нет</span>'}</div>`;
}
function timerPercent(s){
  const q=s.current_question||{},total=Number(q.time_limit||0);
  if(!total)return 100;
  const remaining=Math.max(0,Math.min(total,Number(s.timer_remaining??total)));
  return Math.round(remaining/total*100);
}
function updateStageTimer(s){
  const q=s.current_question||{},value=document.getElementById('stageTimerValue'),bar=document.getElementById('stageTimerBar');
  if(!value||!q.time_limit)return;
  const remaining=Math.max(0,Number(s.timer_remaining??q.time_limit));
  value.textContent=String(remaining);
  if(bar)bar.style.width=timerPercent(s)+'%';
  const ring=value.closest('.stage-timer');
  if(ring){ring.classList.toggle('ended',remaining===0);ring.classList.toggle('stopped',!!s.answers_revealed);}
}
function render(s){
  renderReactions(s);renderReactionCounter(s);
  const root=document.getElementById('content'),g=s.game,q=s.current_question;
  const fullMedia=s.screen_mode==='media_fullscreen'&&s.screen_media;
  document.getElementById('displayRoot').classList.toggle('media-fullscreen-active',!!fullMedia);
  document.getElementById('gameName').textContent=g?.title||'QUIZCONTROL STUDIO';
  if(fullMedia){
    const m=s.screen_media;
    if(m.type==='image')root.innerHTML=`<div class="fullscreen-media-frame"><img class="fullscreen-media-image" src="${esc(m.url)}" alt="${esc(m.name||'Изображение')}"></div>`;
    else if(m.type==='video')root.innerHTML=`<div class="fullscreen-media-frame fullscreen-video-frame"><div id="stageMediaMount" class="fullscreen-media-mount"></div><div id="stageMediaStatus" class="fullscreen-media-status"></div><div id="stageMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить видео и звук</button></div></div>`;
    else root.innerHTML='<div class="fullscreen-media-frame"><div class="stage-muted">Формат файла не поддерживается для полноэкранного показа</div></div>';
    return;
  }
  document.getElementById('stageRound').textContent=q?esc(q.round_title||'ТЕКУЩИЙ РАУНД'):(s.active_round?.title?esc(s.active_round.title):(g?gameNames[g.game_type]||'ИГРА':'ГОТОВЫ К ИГРЕ'));
  if(!g){root.innerHTML='<div class="stage-empty">Создайте игру в панели организатора</div>';return;}
  if(s.screen_mode==='round_summary'&&s.round_summary){
    const summary=s.round_summary,rows=(summary.scoreboard||[]).map((p,i)=>rankRow(p,i,{round:true})).join('');
    root.innerHTML=`<div class="score-stage round-summary-stage"><div class="orange-kicker">РАУНД ЗАВЕРШЁН</div><h1>Итоги раунда</h1><p class="round-summary-title">${esc(summary.title)}</p><div class="round-summary-total">${summary.round_points_total||0}<small>баллов начислено за раунд</small></div><div class="stage-leaderboard">${rows||'<p class="stage-muted">В раунде пока нет результатов</p>'}</div><p class="stage-muted round-summary-footer">Ожидаем следующий раунд</p></div>`;
    return;
  }
  if(s.screen_mode==='scoreboard'){
    const rows=(s.scoreboard||[]).map((p,i)=>rankRow(p,i)).join('');
    root.innerHTML=`<div class="score-stage"><div class="orange-kicker">ТЕКУЩИЕ РЕЗУЛЬТАТЫ</div><h1>Таблица лидеров</h1><div class="stage-leaderboard">${rows||'<p class="stage-muted">Результатов пока нет</p>'}</div></div>`;
    return;
  }
  if(s.screen_mode==='question'&&q){
    const opts=optionHtml(q,s);
    const remaining=Math.max(0,Number(s.timer_remaining??q.time_limit??0));
    const timer=q.time_limit?`<div class="stage-timer-wrap"><div class="stage-timer ${remaining===0?'ended':''} ${s.answers_revealed?'stopped':''}"><span id="stageTimerValue">${remaining}</span><small>СЕКУНД</small></div><div class="stage-timer-progress"><i id="stageTimerBar" style="width:${timerPercent(s)}%"></i></div></div>`:'';
    root.innerHTML=`<div class="question-stage"><div class="question-kicker"><span class="orange-kicker">${esc(q.round_title||'РАУНД')}</span><span class="points-pill">${q.points} БАЛЛ.</span></div><div class="question-layout"><div class="question-copy"><div class="question-title-label">${esc(q.body?(q.title||'ВОПРОС'):'ВОПРОС')}</div><h1>${esc(q.body||q.title||'Вопрос')}</h1>${mediaHtml(q)}${opts?`<div class="stage-options">${opts}</div>`:''}</div><aside class="question-aside">${timer}<div class="answer-status ${s.answers_revealed?'done':''}">${s.answers_revealed?'ОТВЕТЫ ОТКРЫТЫ':s.allow_answers?'ПРИЁМ ОТВЕТОВ':'ОТВЕТЫ УСТНО'}</div>${s.answers_revealed?'<div class="reveal-badge">РЕЗУЛЬТАТЫ ОТКРЫТЫ</div>':''}</aside></div>${statsHtml(s)}</div>`;
    return;
  }
  root.innerHTML=`<div class="welcome-layout"><div class="welcome-copy"><div class="orange-kicker">${s.status==='active'?'МЕРОПРИЯТИЕ ИДЁТ':'ДОБРО ПОЖАЛОВАТЬ'}</div><h1>${esc(g.title)}</h1><p>${esc(g.description||'Приготовьтесь проверить свои знания!')}</p><div class="welcome-facts"><span>${s.rounds.length} РАУНДОВ</span><span>${s.format==='team'?'КОМАНДНАЯ ИГРА':'ИНДИВИДУАЛЬНАЯ ИГРА'}</span><span>${esc(gameNames[g.game_type]||'КВИЗ')}</span></div></div><div class="join-card"><div class="join-card-title">ПОДКЛЮЧИТЬСЯ К ИГРЕ</div><img class="qr" src="/api/connect-qr" alt="QR-код для подключения"><div class="join-url" id="joinUrl">Отсканируйте QR-код телефоном</div><div class="join-hint">${g.allow_registration?'Регистрация открыта':'Регистрация закрыта'}</div></div></div>`;
}
function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(`${proto}://${location.host}/ws`);let sig='';
  ws.onmessage=e=>{try{
    const s=JSON.parse(e.data),x={...s};delete x.timer_remaining;delete x.reaction_events;delete x.reaction_counts;delete x.server_time;delete x.participants;
    if(s.screen_mode!=='scoreboard')delete x.scoreboard;
    if(!s.answers_revealed){delete x.answer_count;delete x.answer_stats;}
    const next=JSON.stringify(x);renderReactions(s);renderReactionCounter(s);
    if(next!==sig){sig=next;render(s);}else updateStageTimer(s);
    window.QuizMediaSync?.apply(s,{mountId:'stageMediaMount',statusId:'stageMediaStatus',noticeId:'stageMediaNotice'});
  }catch(err){console.error(err)}};
  ws.onclose=()=>setTimeout(connect,1800);ws.onerror=()=>ws.close();
}
fetch('/api/state').then(r=>r.json()).then(s=>{render(s);window.QuizMediaSync?.apply(s,{mountId:'stageMediaMount',statusId:'stageMediaStatus',noticeId:'stageMediaNotice'});}).catch(console.error);
fetch('/api/connect-qr').then(r=>{const u=r.headers.get('X-Join-Url');if(u)document.querySelectorAll('.join-url').forEach(el=>el.textContent=u)}).catch(()=>{});
connect();
